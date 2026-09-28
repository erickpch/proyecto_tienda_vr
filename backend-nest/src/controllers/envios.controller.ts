import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../commons/decorators/roles.decorator.js';
import { UsuarioActual } from '../commons/decorators/usuario-actual.decorator.js';
import { CAPACIDAD, Rol } from '../commons/enums/rol.enum.js';
import { PipeId } from '../commons/pipes.js';
import {
  AvanzarEnvioDto,
  CancelarEnvioDto,
  FiltroEnviosDto,
} from '../dto/envio.dto.js';
import type { Usuario } from '../entities/usuario.entity.js';
import { EnviosService } from '../services/envios.service.js';

@ApiTags('Pedidos online y envios')
@ApiBearerAuth()
@Controller('envios')
export class EnviosController {
  constructor(private readonly envios: EnviosService) {}

  @Roles(...CAPACIDAD.pedidos)
  @Get()
  @ApiOperation({
    summary:
      'Pedidos online para despachar. El encargado ve los de su sucursal',
  })
  listar(@Query() filtro: FiltroEnviosDto, @UsuarioActual() actor: Usuario) {
    return this.envios.listar(filtro, actor);
  }

  @Roles(...CAPACIDAD.pedidos)
  @Get(':envio_id')
  @ApiOperation({ summary: 'Pedido con sus productos y seguimiento' })
  obtener(
    @Param('envio_id', PipeId) id: number,
    @UsuarioActual() actor: Usuario,
  ) {
    return this.envios.obtener(id, actor);
  }

  @Roles(...CAPACIDAD.pedidos)
  @Post(':envio_id/estado')
  @ApiOperation({
    summary:
      'Avanzar al siguiente estado. Al entregar una contraentrega, el pago queda cobrado',
  })
  avanzar(
    @Param('envio_id', PipeId) id: number,
    @Body() datos: AvanzarEnvioDto,
    @UsuarioActual() actor: Usuario,
  ) {
    return this.envios.avanzar(id, datos, actor);
  }

  @Roles(...CAPACIDAD.pedidos, Rol.CLIENTE)
  @Post(':envio_id/cancelacion')
  @ApiOperation({
    summary:
      'Cancelar el pedido: devuelve el stock y reembolsa el pago con tarjeta',
  })
  cancelar(
    @Param('envio_id', PipeId) id: number,
    @Body() datos: CancelarEnvioDto,
    @UsuarioActual() actor: Usuario,
  ) {
    return this.envios.cancelar(id, datos, actor);
  }
}
