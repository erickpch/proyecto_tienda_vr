import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EntityManager, QueryFailedError } from 'typeorm';
import {
  aCentavos,
  deCentavos,
  subtotalEnCentavos,
} from '../commons/dinero.js';
import { METODOS_DE_CAJA, MetodoPago } from '../commons/enums/caja.enum.js';
import {
  EstadoEnvio,
  EstadoPago,
  ModalidadEntrega,
} from '../commons/enums/envio.enum.js';
import { Rol } from '../commons/enums/rol.enum.js';
import { ModalidadVenta, TipoVenta } from '../commons/enums/tipo-venta.enum.js';
import { CodigoError, errorDeNegocio } from '../commons/errores.js';
import {
  aplicarPrecios,
  MINIMO_MAYOR_POR_DEFECTO,
  type PrecioAplicado,
} from '../commons/precios.js';
import type { Configuracion } from '../config/configuracion.js';
import type {
  ActualizarVentaDto,
  CrearVentaDto,
  DetalleDeVentaDto,
  EntregaDto,
  FiltroVentasDto,
} from '../dto/venta.dto.js';
import { DetalleVenta } from '../entities/detalle-venta.entity.js';
import { Envio } from '../entities/envio.entity.js';
import { EventoEnvio } from '../entities/evento-envio.entity.js';
import { ProductoSucursal } from '../entities/producto-sucursal.entity.js';
import type { TurnoCaja } from '../entities/turno-caja.entity.js';
import type { Usuario } from '../entities/usuario.entity.js';
import { Venta } from '../entities/venta.entity.js';
import { VentasRepository } from '../repositories/ventas.repository.js';
import { BitacoraService } from './bitacora.service.js';
import { PagosService } from './pagos.service.js';

const NO_ENCONTRADA = 'Venta no encontrada';
const VIOLACION_DE_UNICIDAD = '23505';

const RETIRO: EntregaDto = { modalidad: ModalidadEntrega.RETIRO };

@Injectable()
export class VentasService {
  private readonly contraentregaPendientesMax: number;

  constructor(
    private readonly repo: VentasRepository,
    private readonly pagos: PagosService,
    private readonly bitacora: BitacoraService,
    config: ConfigService<Configuracion, true>,
  ) {
    this.contraentregaPendientesMax = config.get('envios', {
      infer: true,
    }).contraentregaPendientesMax;
  }

  listar(filtro: FiltroVentasDto, actor: Usuario): Promise<Venta[]> {
    const usuarioId = this.esCliente(actor) ? actor.id : filtro.usuario_id;
    return this.repo.listar(usuarioId, filtro.tipo_venta);
  }

  async obtener(id: number, actor: Usuario): Promise<Venta> {
    const venta = await this.repo.obtenerCompleta(id);
    if (!venta) throw new NotFoundException(NO_ENCONTRADA);

    if (this.esCliente(actor) && venta.usuario_id !== actor.id) {
      throw new ForbiddenException('Esa venta no es tuya');
    }

    return venta;
  }

  async crear(datos: CrearVentaDto, actor: Usuario): Promise<Venta> {
    const esCliente = this.esCliente(actor);
    const usuarioId = esCliente ? actor.id : datos.usuario_id;

    if (!(await this.repo.existeUsuario(usuarioId))) {
      throw new BadRequestException('El usuario no existe');
    }

    // Reintento de una venta ya registrada (por ejemplo, la cola offline del POS).
    if (datos.id_cliente) {
      const previa = await this.ventaYaRegistrada(
        datos.id_cliente,
        actor,
        usuarioId,
      );
      if (previa) return previa;
    }

    this.verificarReglasDePago(datos, esCliente);
    const presencial = datos.tipo_venta === TipoVenta.PRESENCIAL;
    const entrega = presencial ? null : (datos.entrega ?? RETIRO);
    const metodoPago = datos.pago_id
      ? MetodoPago.TARJETA
      : (datos.metodo_pago ?? null);
    const contraentrega = metodoPago === MetodoPago.CONTRAENTREGA;

    if (contraentrega) {
      await this.verificarLimiteDeContraentrega(usuarioId);
    }
    const costoEnvio = entrega ? await this.costoDeEnvio(entrega) : 0;

    let totalVerificado: string | null = null;
    if (datos.pago_id) {
      if (await this.repo.pagoYaUsado(datos.pago_id)) {
        throw new ConflictException('Ese pago ya esta asociado a otra venta');
      }
      totalVerificado = await this.totalDe(datos.detalles, entrega);
      await this.pagos.verificar(datos.pago_id, totalVerificado);
    }

    let venta: Venta;
    try {
      venta = await this.registrar(
        datos,
        actor,
        usuarioId,
        entrega,
        metodoPago,
        costoEnvio,
        totalVerificado,
      );
    } catch (error) {
      if (datos.id_cliente && this.esDuplicada(error)) {
        const previa = await this.ventaYaRegistrada(
          datos.id_cliente,
          actor,
          usuarioId,
        );
        if (previa) return previa;
      }
      throw error;
    }

    if (datos.pago_id) {
      await this.pagos.marcarVenta(datos.pago_id, venta.id);
    }

    return (await this.repo.obtenerCompleta(venta.id)) ?? venta;
  }

  private registrar(
    datos: CrearVentaDto,
    actor: Usuario,
    usuarioId: number,
    entrega: EntregaDto | null,
    metodoPago: MetodoPago | null,
    costoEnvio: number,
    totalVerificado: string | null,
  ): Promise<Venta> {
    const presencial = datos.tipo_venta === TipoVenta.PRESENCIAL;
    const contraentrega = metodoPago === MetodoPago.CONTRAENTREGA;

    return this.repo.transaccion(async (manager) => {
      const turno = presencial
        ? await this.turnoParaCobrar(manager, actor)
        : null;

      const pedido = this.agruparPorStock(datos.detalles);
      const stocks = await this.bloquearYValidar(manager, pedido);

      if (turno !== null) {
        this.verificarSucursalDelTurno(turno.sucursal_id, stocks);
      }
      const sucursalDespacho = entrega ? this.sucursalUnica(stocks) : null;

      const precios = this.preciosDelPedido(pedido, stocks);
      let totalCentavos = costoEnvio;
      for (const [stockId, cantidad] of pedido) {
        totalCentavos += subtotalEnCentavos(
          precios.get(stockId)!.precio,
          cantidad,
        );
      }
      const total = deCentavos(totalCentavos);
      const porMayor = [...precios.values()].some((p) => p.por_mayor);

      if (totalVerificado !== null && total !== totalVerificado) {
        throw new ConflictException(
          'Los precios cambiaron mientras se procesaba el pago. No se registro la venta.',
        );
      }

      const venta = await manager.getRepository(Venta).save(
        manager.getRepository(Venta).create({
          tipo_venta: datos.tipo_venta,
          modalidad: porMayor ? ModalidadVenta.MAYOR : ModalidadVenta.MENOR,
          usuario_id: usuarioId,
          total,
          pago_id: datos.pago_id ?? null,
          metodo_pago: metodoPago,
          estado_pago: contraentrega ? EstadoPago.PENDIENTE : EstadoPago.PAGADO,
          turno_id: turno?.id ?? null,
          id_cliente: datos.id_cliente ?? null,
        }),
      );

      if (turno && datos.registrada_en) {
        await this.fijarMomentoDeCobro(
          manager,
          venta.id,
          turno.id,
          datos.registrada_en,
        );
      }

      for (const [stockId, cantidad] of pedido) {
        const stock = stocks.get(stockId)!;

        await manager.getRepository(DetalleVenta).save(
          manager.getRepository(DetalleVenta).create({
            venta_id: venta.id,
            producto_sucursal_id: stock.id,
            cantidad,
            precio: precios.get(stockId)!.precio,
            precio_lista: stock.precio,
          }),
        );

        stock.cantidad -= cantidad;
        await manager.getRepository(ProductoSucursal).save(stock);

        await this.bitacora.registrar(
          manager,
          actor,
          `Venta #${venta.id}: salida de ${cantidad} unidad(es)`,
          stock.producto?.nombre ?? null,
        );
      }

      if (entrega && sucursalDespacho !== null) {
        await this.crearEnvio(
          manager,
          venta.id,
          entrega,
          sucursalDespacho,
          costoEnvio,
          actor,
        );
      }

      return venta;
    });
  }

  /**
   * Venta ya guardada con ese id_cliente. Solo la devuelve a quien la registro
   * (el cajero del turno o el mismo comprador); si no, es un UUID ajeno.
   */
  private async ventaYaRegistrada(
    idCliente: string,
    actor: Usuario,
    usuarioId: number,
  ): Promise<Venta | null> {
    const previa = await this.repo.porIdCliente(idCliente);
    if (!previa) return null;

    const propia = previa.turno
      ? previa.turno.cajero_id === actor.id
      : previa.usuario_id === usuarioId;
    if (!propia) {
      throw new ConflictException('Ese id_cliente ya pertenece a otra venta');
    }
    return (await this.repo.obtenerCompleta(previa.id)) ?? previa;
  }

  /**
   * Hora real de una venta cobrada sin conexion, acotada al turno: no antes de que
   * abriera ni despues de ahora (el reloj del equipo puede estar desfasado).
   * La calcula Postgres para usar la misma zona horaria que los DEFAULT now().
   */
  private async fijarMomentoDeCobro(
    manager: EntityManager,
    ventaId: number,
    turnoId: number,
    registradaEn: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Venta)
      .set({
        creada_en: () =>
          `LEAST(now()::timestamp, GREATEST(
             (SELECT abierto_en FROM turnos_caja WHERE id = :turnoId),
             CAST(:registradaEn AS timestamptz)::timestamp))`,
      })
      .where('id = :ventaId', { ventaId })
      .setParameters({
        turnoId,
        registradaEn: new Date(registradaEn).toISOString(),
      })
      .execute();
  }

  private esDuplicada(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string } | undefined)?.code ===
        VIOLACION_DE_UNICIDAD
    );
  }

  async actualizar(id: number, datos: ActualizarVentaDto): Promise<Venta> {
    const venta = await this.repo.obtener(id);
    if (!venta) throw new NotFoundException(NO_ENCONTRADA);

    Object.assign(venta, datos);
    return this.repo.guardar(venta);
  }

  async anular(id: number, actor: Usuario): Promise<{ mensaje: string }> {
    await this.repo.transaccion(async (manager) => {
      const venta = await manager.getRepository(Venta).findOne({
        where: { id },
        relations: { detalles: true },
      });
      if (!venta) throw new NotFoundException(NO_ENCONTRADA);

      if (venta.turno_id !== null) {
        const turno = await this.repo.turnoBloqueado(manager, venta.turno_id);
        if (turno?.cerrado_en) {
          throw new ConflictException(
            `La venta pertenece al turno #${turno.id}, que ya fue cerrado y arqueado: no se puede anular`,
          );
        }
      }

      // Un pedido cancelado ya devolvio su stock.
      if (!venta.cancelada_en) {
        await this.reingresarStock(
          manager,
          venta.detalles ?? [],
          actor,
          `Anulacion venta #${venta.id}`,
        );
      }

      await manager.getRepository(Venta).delete({ id });
    });

    return { mensaje: 'Venta anulada, el stock fue devuelto' };
  }

  /** Devuelve al stock de la sucursal las unidades de una venta. */
  async reingresarStock(
    manager: EntityManager,
    detalles: DetalleVenta[],
    actor: Usuario,
    motivo: string,
  ): Promise<void> {
    const ids = [
      ...new Set(detalles.map((detalle) => detalle.producto_sucursal_id)),
    ];
    if (ids.length === 0) return;

    const stocks = new Map(
      (await this.repo.bloquearStock(manager, ids)).map((stock) => [
        stock.id,
        stock,
      ]),
    );

    for (const detalle of detalles) {
      const stock = stocks.get(detalle.producto_sucursal_id);
      if (!stock) continue;

      stock.cantidad += detalle.cantidad;
      await manager.getRepository(ProductoSucursal).save(stock);

      await this.bitacora.registrar(
        manager,
        actor,
        `${motivo}: reingreso de ${detalle.cantidad} unidad(es)`,
        stock.producto?.nombre ?? null,
      );
    }
  }

  /** Total a cobrar: productos mas el envio a domicilio, si corresponde. */
  async totalDe(
    detalles: DetalleDeVentaDto[],
    entrega: EntregaDto | null = null,
  ): Promise<string> {
    const pedido = this.agruparPorStock(detalles);
    const stocks = await this.repo.stockPorIds([...pedido.keys()]);
    const porId = new Map(stocks.map((stock) => [stock.id, stock]));

    for (const [stockId, cantidad] of pedido) {
      const stock = porId.get(stockId);
      if (!stock)
        throw new BadRequestException(`No existe el stock ${stockId}`);

      const disponible = stock.cantidad - stock.cantidad_reservada;
      if (disponible < cantidad) {
        throw new ConflictException(
          `Stock insuficiente para el producto ${stock.producto_id}: ` +
            `quedan ${disponible}, se piden ${cantidad}`,
        );
      }
    }

    const precios = this.preciosDelPedido(pedido, porId);
    let totalCentavos = entrega ? await this.costoDeEnvio(entrega) : 0;
    for (const [stockId, cantidad] of pedido) {
      totalCentavos += subtotalEnCentavos(
        precios.get(stockId)!.precio,
        cantidad,
      );
    }

    return deCentavos(totalCentavos);
  }

  /** Precio unitario de cada linea, con el precio por mayor si el pedido alcanza el minimo. */
  private preciosDelPedido(
    pedido: Map<number, number>,
    stocks: Map<number, ProductoSucursal>,
  ): Map<number, PrecioAplicado> {
    return aplicarPrecios(
      [...pedido].map(([stockId, cantidad]) => {
        const stock = stocks.get(stockId)!;
        return {
          clave: stockId,
          cantidad,
          precio: stock.precio,
          precio_mayor: stock.producto?.precio_mayor ?? null,
          minimo_mayor:
            stock.producto?.minimo_mayor ?? MINIMO_MAYOR_POR_DEFECTO,
        };
      }),
    );
  }

  /** Costo del envio en centavos: el retiro es gratis y el domicilio usa la tarifa de la ciudad. */
  private async costoDeEnvio(entrega: EntregaDto): Promise<number> {
    if (entrega.modalidad === ModalidadEntrega.RETIRO) return 0;

    const ciudad = await this.repo.ciudad(entrega.ciudad_id!);
    if (!ciudad) throw new BadRequestException('La ciudad no existe');
    if (ciudad.costo_envio === null) {
      throw new BadRequestException(
        `Todavia no hacemos envios a ${ciudad.nombre}: elegi retiro en sucursal`,
      );
    }
    return aCentavos(ciudad.costo_envio);
  }

  private async crearEnvio(
    manager: EntityManager,
    ventaId: number,
    entrega: EntregaDto,
    sucursalId: number,
    costoCentavos: number,
    actor: Usuario,
  ): Promise<void> {
    const domicilio = entrega.modalidad === ModalidadEntrega.DOMICILIO;
    const repo = manager.getRepository(Envio);

    await repo.save(
      repo.create({
        venta_id: ventaId,
        modalidad: entrega.modalidad,
        estado: EstadoEnvio.PENDIENTE,
        sucursal_id: sucursalId,
        ciudad_id: domicilio ? entrega.ciudad_id : null,
        direccion: domicilio ? entrega.direccion!.trim() : null,
        referencia: domicilio ? entrega.referencia?.trim() || null : null,
        destinatario: domicilio ? entrega.destinatario!.trim() : null,
        telefono: domicilio ? entrega.telefono!.trim() : null,
        costo: deCentavos(costoCentavos),
        eventos: [
          manager.getRepository(EventoEnvio).create({
            estado: EstadoEnvio.PENDIENTE,
            nota: 'Pedido recibido',
            usuario_id: actor.id,
          }),
        ],
      }),
    );
  }

  private verificarReglasDePago(
    datos: CrearVentaDto,
    esCliente: boolean,
  ): void {
    const presencial = datos.tipo_venta === TipoVenta.PRESENCIAL;

    if (esCliente && presencial) {
      throw new ForbiddenException(
        'Un cliente no puede registrar ventas presenciales: las cobra la caja de la sucursal',
      );
    }

    if (presencial) {
      if (!datos.metodo_pago || !METODOS_DE_CAJA.includes(datos.metodo_pago)) {
        throw new BadRequestException(
          'Indica el metodo de pago de la venta presencial (efectivo, tarjeta o qr)',
        );
      }
      if (datos.entrega) {
        throw new BadRequestException(
          'La venta presencial se entrega en el mostrador: no lleva datos de envio',
        );
      }
    }

    if (datos.metodo_pago === MetodoPago.CONTRAENTREGA) {
      if (datos.pago_id) {
        throw new BadRequestException(
          'Un pedido contraentrega no lleva pago por la pasarela',
        );
      }
      if (datos.entrega?.modalidad !== ModalidadEntrega.DOMICILIO) {
        throw new BadRequestException(
          'El pago contraentrega solo esta disponible con envio a domicilio',
        );
      }
      return;
    }

    if (datos.pago_id) {
      this.pagos.exigirPasarela();
      return;
    }

    if (esCliente && this.pagos.habilitado) {
      throw new HttpException(
        'Falta el pago: la compra virtual debe pagarse con la pasarela o contraentrega',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  private async verificarLimiteDeContraentrega(
    usuarioId: number,
  ): Promise<void> {
    const pendientes = await this.repo.contraentregasPendientes(usuarioId);
    if (pendientes >= this.contraentregaPendientesMax) {
      throw new ConflictException(
        `Ya tenes ${pendientes} pedido(s) contraentrega sin entregar: ` +
          'espera a recibirlos o paga con tarjeta',
      );
    }
  }

  /** La venta presencial se cobra siempre dentro del turno abierto de quien la registra. */
  private async turnoParaCobrar(
    manager: EntityManager,
    actor: Usuario,
  ): Promise<TurnoCaja> {
    const turno = await this.repo.turnoAbiertoBloqueado(manager, actor.id);
    if (!turno) {
      throw new ConflictException(
        'No tenes un turno de caja abierto: abri uno antes de cobrar',
      );
    }
    return turno;
  }

  private verificarSucursalDelTurno(
    sucursalId: number,
    stocks: Map<number, ProductoSucursal>,
  ): void {
    for (const stock of stocks.values()) {
      if (stock.sucursal_id !== sucursalId) {
        throw new ConflictException(
          'Hay productos de otra sucursal: el turno solo cobra stock de su propia sucursal',
        );
      }
    }
  }

  /** Un pedido online sale de una sola sucursal. */
  private sucursalUnica(stocks: Map<number, ProductoSucursal>): number {
    const sucursales = new Set(
      [...stocks.values()].map((stock) => stock.sucursal_id),
    );
    if (sucursales.size !== 1) {
      throw errorDeNegocio(
        ConflictException,
        CodigoError.SUCURSALES_MEZCLADAS,
        'Todos los productos del pedido deben ser de la misma sucursal',
      );
    }
    return [...sucursales][0];
  }

  private agruparPorStock(detalles: DetalleDeVentaDto[]): Map<number, number> {
    const pedido = new Map<number, number>();
    for (const linea of detalles) {
      pedido.set(
        linea.producto_sucursal_id,
        (pedido.get(linea.producto_sucursal_id) ?? 0) + linea.cantidad,
      );
    }
    return pedido;
  }

  private async bloquearYValidar(
    manager: EntityManager,
    pedido: Map<number, number>,
  ): Promise<Map<number, ProductoSucursal>> {
    const ids = [...pedido.keys()];
    const filas = await this.repo.bloquearStock(manager, ids);
    const stocks = new Map(filas.map((stock) => [stock.id, stock]));

    for (const [stockId, cantidad] of pedido) {
      const stock = stocks.get(stockId);
      if (!stock)
        throw new BadRequestException(`No existe el stock ${stockId}`);

      const disponible = stock.cantidad - stock.cantidad_reservada;
      if (disponible < cantidad) {
        throw new ConflictException(
          `Stock insuficiente para el producto ${stock.producto_id}: ` +
            `quedan ${disponible}, se piden ${cantidad}`,
        );
      }
    }

    const conProducto = await manager.getRepository(ProductoSucursal).find({
      where: ids.map((id) => ({ id })),
      relations: { producto: true },
    });
    for (const fila of conProducto) {
      const stock = stocks.get(fila.id);
      if (stock) stock.producto = fila.producto;
    }

    return stocks;
  }

  private esCliente(usuario: Usuario): boolean {
    return usuario.rol?.nombre === Rol.CLIENTE;
  }
}
