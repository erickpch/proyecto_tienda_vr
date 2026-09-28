import { Fragment, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useCarrito, useCarritoStore } from '@/core/stores/carrito.store'
import { resumenItems } from '@/core/stores/lista-items'
import { useAuth, useAuthStore } from '@/core/stores/auth.store'
import { toast } from '@/core/stores/toast.store'
import { ventasService } from '@/features/ventas/services/ventas.service'
import { catalogoService } from '@/features/catalogo/services/catalogo.service'
import { ciudadesService } from '@/features/ciudades/services/ciudades.service'
import { pagosService } from '../services/pagos.service'
import { monedaBs } from '@/shared/utils/moneda-bs'
import { cx } from '@/shared/utils/clases'

const PASOS = [
  { n: 1, titulo: 'Entrega' },
  { n: 2, titulo: 'Pago' },
  { n: 3, titulo: 'Confirmación' },
]

// Cobrar "al contado" registra una venta presencial: exige un turno de caja abierto.
const ROLES_CONTADO = ['administrador', 'cajero']

const PATRON_TELEFONO = /^\+?\d{6,15}$/

// La entrega se guarda antes de ir a Stripe: si el banco redirige (3D Secure), se recupera al volver.
const CLAVE_ENTREGA = 'checkout_entrega'

const refrescarCatalogo = () => catalogoService.refrescar().catch(() => {})

function leerEntregaGuardada() {
  try {
    const raw = sessionStorage.getItem(CLAVE_ENTREGA)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function guardarEntrega(entrega) {
  try {
    sessionStorage.setItem(CLAVE_ENTREGA, JSON.stringify(entrega))
  } catch {
    // Sin almacenamiento: si hay redirección, el pedido se registra como retiro y el backend lo rechaza por monto.
  }
}

function olvidarEntrega() {
  try {
    sessionStorage.removeItem(CLAVE_ENTREGA)
  } catch {
    // nada que limpiar
  }
}

export default function Checkout() {
  const carrito = useCarrito()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const auth = useAuth()
  const puedeContado = auth.tieneRol(...ROLES_CONTADO)

  const [inicio] = useState(() => {
    const items = useCarritoStore.getState().items
    return {
      vacio: items.length === 0,
      mezclado: resumenItems(items).mezclado,
      secreto: searchParams.get('payment_intent_client_secret'),
    }
  })
  const retomando = !inicio.vacio && !inicio.mezclado && !!inicio.secreto

  const [ciudades, setCiudades] = useState([])
  const [entrega, setEntrega] = useState(() => {
    const guardada = retomando ? leerEntregaGuardada() : null
    const u = auth.usuario
    return (
      guardada ?? {
        modalidad: 'retiro',
        ciudad_id: '',
        direccion: '',
        referencia: '',
        destinatario: u ? `${u.nombre} ${u.apellido}` : '',
        telefono: '',
      }
    )
  })
  const domicilio = entrega.modalidad === 'domicilio'
  const ciudadesConEnvio = ciudades.filter((c) => c.costo_envio !== null)
  const ciudadElegida = ciudadesConEnvio.find((c) => c.id === Number(entrega.ciudad_id)) ?? null
  const costoEnvio = domicilio && ciudadElegida ? Number(ciudadElegida.costo_envio) : 0
  const total = carrito.total + costoEnvio
  const entregaValida =
    !domicilio ||
    (ciudadElegida !== null &&
      entrega.direccion.trim() !== '' &&
      entrega.destinatario.trim() !== '' &&
      PATRON_TELEFONO.test(entrega.telefono.trim()))

  const [stripeHabilitado] = useState(() => pagosService.habilitado)
  const [metodo, setMetodo] = useState(() => (puedeContado && !retomando ? 'contado' : 'pasarela'))
  const alContado = metodo === 'contado'
  const contraentrega = metodo === 'contraentrega'
  const [paso, setPaso] = useState(retomando ? 3 : 1)
  const [pagando, setPagando] = useState(retomando)
  const [errorPago, setErrorPago] = useState(null)
  const [qrConfirmado, setQrConfirmado] = useState(false)

  const [intencion, setIntencion] = useState(null)
  const [preparandoPago, setPreparandoPago] = useState(false)
  const [errorIntencion, setErrorIntencion] = useState(null)
  const [metodoListo, setMetodoListo] = useState(false)
  const [marcaQR] = useState(() => Date.now())

  const contenedorPagoRef = useRef(null)
  const stripeRef = useRef(null)
  const elementsRef = useRef(null)
  const elementoPagoRef = useRef(null)
  const montadoRef = useRef(null)
  const firmaUsadaRef = useRef(null)
  const iniciadoRef = useRef(false)

  const firmaCarrito =
    carrito.items.map((i) => `${i.producto_sucursal_id}x${i.cantidad}`).join('|') +
    `|${entrega.modalidad}:${domicilio ? entrega.ciudad_id : ''}`

  const pagoListo =
    alContado || contraentrega || (stripeHabilitado ? !!intencion && metodoListo : qrConfirmado)

  const urlQR = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=6&data=${encodeURIComponent(
    `FashionStore|pago|Bs ${total.toFixed(2)}|${marcaQR}`,
  )}`

  const metodos = [
    ...(puedeContado && !domicilio ? [{ valor: 'contado', icono: 'payments', etiqueta: 'Al contado' }] : []),
    {
      valor: 'pasarela',
      icono: stripeHabilitado ? 'credit_card' : 'qr_code_2',
      etiqueta: stripeHabilitado ? 'Tarjeta' : 'QR bancario',
    },
    ...(domicilio ? [{ valor: 'contraentrega', icono: 'local_shipping', etiqueta: 'Contraentrega' }] : []),
  ]

  const entregaParaApi = () =>
    domicilio
      ? {
          modalidad: 'domicilio',
          ciudad_id: Number(entrega.ciudad_id),
          direccion: entrega.direccion.trim(),
          referencia: entrega.referencia.trim() || null,
          destinatario: entrega.destinatario.trim(),
          telefono: entrega.telefono.trim(),
        }
      : { modalidad: 'retiro' }

  useEffect(() => {
    ciudadesService
      .listar()
      .then(setCiudades)
      .catch(() => {})
  }, [])

  const cambiarEntrega = (campo, valor) => setEntrega((e) => ({ ...e, [campo]: valor }))

  const elegirModalidad = (modalidad) => {
    setEntrega((e) => ({ ...e, modalidad }))
    if (modalidad === 'domicilio' && metodo === 'contado') setMetodo('pasarela')
    if (modalidad === 'retiro' && metodo === 'contraentrega') setMetodo(puedeContado ? 'contado' : 'pasarela')
  }

  const destruirElemento = () => {
    elementoPagoRef.current?.destroy()
    elementoPagoRef.current = null
    elementsRef.current = null
    montadoRef.current = null
    firmaUsadaRef.current = null
  }

  const desmontarPago = () => {
    destruirElemento()
    setMetodoListo(false)
    setIntencion(null)
  }

  const montarPago = async (nodo, datos) => {
    if (montadoRef.current === datos.client_secret) return

    const stripe = await pagosService.stripe()
    if (!stripe) {
      setErrorIntencion('No pudimos cargar la pasarela de pago. Revisa tu conexión.')
      return
    }

    stripeRef.current = stripe
    elementsRef.current = stripe.elements({
      clientSecret: datos.client_secret,
      appearance: {
        theme: 'stripe',
        variables: { fontFamily: 'Inter, system-ui, sans-serif', borderRadius: '8px' },
      },
    })

    elementoPagoRef.current = elementsRef.current.create('payment', {
      layout: 'tabs',
      wallets: { applePay: 'never', googlePay: 'never' },
    })
    elementoPagoRef.current.on('change', (evento) => setMetodoListo(evento.complete))
    elementoPagoRef.current.mount(nodo)
    montadoRef.current = datos.client_secret
  }

  const sincronizarIntencion = () => {
    if (!stripeHabilitado) return

    const firma = firmaCarrito
    if (intencion && firmaUsadaRef.current === firma) return

    const items = useCarritoStore.getState().items
    if (items.length === 0) return

    desmontarPago()
    setPreparandoPago(true)
    setErrorIntencion(null)

    pagosService
      .crearIntencion(
        items.map((i) => ({ producto_sucursal_id: i.producto_sucursal_id, cantidad: i.cantidad })),
        entregaParaApi(),
      )
      .then((nueva) => {
        firmaUsadaRef.current = firma
        setIntencion(nueva)
        setPreparandoPago(false)
      })
      .catch((e) => {
        setPreparandoPago(false)
        setErrorIntencion(e.message)
        if (e.status === 409) refrescarCatalogo()
      })
  }

  const mensajeDeError = (e, pagoId) => {
    if (e.status === 409 && pagoId) {
      return `${e.message} El cobro de prueba quedó hecho pero la venta no se registró: avisa al comercio con el código ${pagoId}.`
    }
    if (e.status === 409) {
      return `${e.message}. Ajusta las cantidades en el carrito e intenta de nuevo.`
    }
    return e.message
  }

  const registrarVenta = (pagoId, { presencial = false, metodoPago = null } = {}) => {
    const usuario = useAuthStore.getState().usuario
    if (!usuario) return

    ventasService
      .crear({
        tipo_venta: presencial ? 'presencial' : 'virtual',
        usuario_id: usuario.id,
        detalles: useCarritoStore
          .getState()
          .items.map((i) => ({ producto_sucursal_id: i.producto_sucursal_id, cantidad: i.cantidad })),
        ...(pagoId ? { pago_id: pagoId } : {}),
        ...(metodoPago ? { metodo_pago: metodoPago } : {}),
        ...(presencial ? {} : { entrega: entregaParaApi() }),
      })
      .then((venta) => {
        desmontarPago()
        olvidarEntrega()
        useCarritoStore.getState().vaciar()
        refrescarCatalogo()
        navigate(`/compra-exitosa/${venta.id}`)
      })
      .catch((e) => {
        setPagando(false)
        setErrorPago(mensajeDeError(e, pagoId))
        if (e.status === 409) refrescarCatalogo()
      })
  }

  const resolverRetorno = async (clientSecret) => {
    const stripe = await pagosService.stripe()
    if (!stripe) {
      setPagando(false)
      setErrorPago('No pudimos cargar la pasarela para confirmar el pago.')
      return
    }

    const { paymentIntent, error } = await stripe.retrievePaymentIntent(clientSecret)

    if (error || !paymentIntent) {
      setPagando(false)
      setErrorPago(error?.message ?? 'No pudimos recuperar el estado del pago.')
      return
    }

    if (paymentIntent.status === 'succeeded') {
      registrarVenta(paymentIntent.id)
      return
    }

    setPagando(false)
    setPaso(2)
    setErrorPago(
      paymentIntent.status === 'requires_payment_method'
        ? 'El pago no se completó. Elige un método e intenta de nuevo.'
        : `El pago quedó en estado "${paymentIntent.status}". No se registró la compra.`,
    )
    sincronizarIntencion()
  }

  useEffect(() => {
    if (iniciadoRef.current) return
    iniciadoRef.current = true

    if (inicio.vacio) {
      toast.info('Tu carrito está vacío.')
      navigate('/catalogo')
    } else if (inicio.mezclado) {
      toast.advertencia('Todos los productos deben ser de la misma sucursal.')
      useCarritoStore.getState().abrir()
      navigate('/catalogo')
    } else if (inicio.secreto) {
      const secreto = inicio.secreto
      Promise.resolve().then(() => resolverRetorno(secreto))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const nodo = contenedorPagoRef.current
    if (!nodo || !intencion) return
    montarPago(nodo, intencion)
  }, [intencion])

  useEffect(() => {
    const elemento = elementoPagoRef
    return () => elemento.current?.destroy()
  }, [])

  const irA = (p) => {
    if (p < paso) setPaso(p)
  }

  const elegirMetodo = (nuevo) => {
    setMetodo(nuevo)
    if (nuevo === 'pasarela') sincronizarIntencion()
  }

  const siguiente = () => {
    if (paso === 1) {
      if (!entregaValida) return
      setPaso(2)
      if (metodo === 'pasarela') sincronizarIntencion()
      return
    }
    if (paso === 2) {
      if (!pagoListo) return
      setPaso(3)
    }
  }

  const pagar = async () => {
    const usuario = useAuthStore.getState().usuario
    if (!usuario || carrito.items.length === 0 || carrito.mezclado || !pagoListo) return

    setPagando(true)
    setErrorPago(null)

    if (alContado) {
      registrarVenta(null, { presencial: true, metodoPago: 'efectivo' })
      return
    }

    if (contraentrega) {
      registrarVenta(null, { metodoPago: 'contraentrega' })
      return
    }

    if (!stripeHabilitado) {
      registrarVenta(null, { metodoPago: 'qr' })
      return
    }

    const stripe = stripeRef.current
    const elements = elementsRef.current
    if (!stripe || !elements || !intencion) {
      setPagando(false)
      setErrorPago('La pasarela no está lista. Vuelve al paso de pago e intenta de nuevo.')
      return
    }

    guardarEntrega(entrega)
    const resultado = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/checkout` },
      redirect: 'if_required',
    })

    if (resultado.error) {
      setPagando(false)
      setErrorPago(resultado.error.message ?? 'El pago fue rechazado.')
      return
    }

    if (resultado.paymentIntent?.status !== 'succeeded') {
      setPagando(false)
      setErrorPago(`El pago quedó en estado "${resultado.paymentIntent?.status}". No se registró la compra.`)
      return
    }

    registrarVenta(intencion.pago_id)
  }

  const etiquetaPago = alContado
    ? 'Al contado (turno de caja)'
    : contraentrega
      ? 'Contraentrega: pagas en efectivo al recibir'
      : stripeHabilitado
        ? 'Tarjeta (Stripe modo prueba)'
        : 'QR bancario (simulado)'

  return (
    <div className="mx-auto max-w-[1100px]">
      <h1 className="text-2xl font-semibold text-on-surface">Finalizar compra</h1>

      <ol className="mt-6 flex items-center gap-2">
        {PASOS.map((p, i) => (
          <Fragment key={p.n}>
            <li className="flex items-center gap-2">
              <button
                type="button"
                className={cx(
                  'flex items-center gap-2 text-sm font-semibold',
                  paso >= p.n ? 'text-on-surface' : 'text-on-surface-variant',
                )}
                disabled={p.n >= paso}
                onClick={() => irA(p.n)}
              >
                <span
                  className={cx(
                    'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors',
                    paso > p.n
                      ? 'bg-success text-white'
                      : paso === p.n
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container-low text-on-surface-variant',
                  )}
                >
                  {paso > p.n ? <span className="material-symbols-outlined text-[18px]">check</span> : p.n}
                </span>
                <span className="hidden sm:inline">{p.titulo}</span>
              </button>
            </li>
            {i < PASOS.length - 1 && <li className="h-px w-10 flex-1 bg-outline-variant sm:w-16" aria-hidden="true"></li>}
          </Fragment>
        ))}
      </ol>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
        <section className="lg:col-span-7">
          {paso === 1 && (
            <div className="tarjeta">
              <h2 className="text-lg font-semibold text-on-surface">¿Cómo quieres recibir tu pedido?</h2>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  {
                    valor: 'retiro',
                    icono: 'storefront',
                    titulo: 'Retiro en sucursal',
                    detalle: carrito.sucursal ? `${carrito.sucursal.nombre} · sin costo` : 'Sin costo',
                  },
                  {
                    valor: 'domicilio',
                    icono: 'local_shipping',
                    titulo: 'Envío a domicilio',
                    detalle: 'Tarifa según la ciudad · pago con tarjeta o contraentrega',
                  },
                ].map((m) => (
                  <button
                    key={m.valor}
                    type="button"
                    className={cx(
                      'flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors',
                      entrega.modalidad === m.valor
                        ? 'border-primary bg-surface-container'
                        : 'border-outline-variant hover:border-primary',
                    )}
                    onClick={() => elegirModalidad(m.valor)}
                  >
                    <span className="material-symbols-outlined text-[28px] text-primary">{m.icono}</span>
                    <span>
                      <span className="block text-sm font-semibold text-on-surface">{m.titulo}</span>
                      <span className="block text-xs text-on-surface-variant">{m.detalle}</span>
                    </span>
                  </button>
                ))}
              </div>

              {domicilio && (
                <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="etiqueta" htmlFor="ent-ciudad">
                      Ciudad
                    </label>
                    <select
                      id="ent-ciudad"
                      className="campo"
                      value={entrega.ciudad_id}
                      onChange={(e) => cambiarEntrega('ciudad_id', e.target.value)}
                    >
                      <option value="">Elige la ciudad</option>
                      {ciudadesConEnvio.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre} · {monedaBs(c.costo_envio)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="etiqueta" htmlFor="ent-telefono">
                      Teléfono de contacto
                    </label>
                    <input
                      id="ent-telefono"
                      type="tel"
                      inputMode="tel"
                      className={cx(
                        'campo',
                        entrega.telefono && !PATRON_TELEFONO.test(entrega.telefono.trim()) && 'campo-invalido',
                      )}
                      placeholder="70012345"
                      value={entrega.telefono}
                      onChange={(e) => cambiarEntrega('telefono', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="etiqueta" htmlFor="ent-direccion">
                      Dirección
                    </label>
                    <input
                      id="ent-direccion"
                      type="text"
                      maxLength={255}
                      className="campo"
                      placeholder="Calle, número, barrio"
                      value={entrega.direccion}
                      onChange={(e) => cambiarEntrega('direccion', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="etiqueta" htmlFor="ent-destinatario">
                      Quién recibe
                    </label>
                    <input
                      id="ent-destinatario"
                      type="text"
                      maxLength={150}
                      className="campo"
                      value={entrega.destinatario}
                      onChange={(e) => cambiarEntrega('destinatario', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="etiqueta" htmlFor="ent-referencia">
                      Referencia <span className="font-normal normal-case">(opcional)</span>
                    </label>
                    <input
                      id="ent-referencia"
                      type="text"
                      maxLength={255}
                      className="campo"
                      placeholder="Ej. portón negro, 2do piso"
                      value={entrega.referencia}
                      onChange={(e) => cambiarEntrega('referencia', e.target.value)}
                    />
                  </div>
                  {ciudades.length > 0 && ciudadesConEnvio.length < ciudades.length && (
                    <p className="text-xs text-on-surface-variant sm:col-span-2">
                      ¿No ves tu ciudad? Todavía no llegamos ahí: elige retiro en sucursal.
                    </p>
                  )}
                </div>
              )}

              <h3 className="mt-8 text-sm font-semibold text-on-surface">Productos</h3>
              <ul className="mt-2 divide-y divide-outline-variant">
                {carrito.lineas.map((item) => (
                  <li key={item.producto_sucursal_id} className="flex items-center gap-3 py-3">
                    <div className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-container">
                      {item.foto && <img src={item.foto} alt={item.nombre} className="h-full w-full object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{item.nombre}</p>
                      <p className="text-xs text-on-surface-variant">
                        {item.color} · Talla {item.talla} · x{item.cantidad}
                      </p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums">{monedaBs(item.precio_aplicado * item.cantidad)}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex items-center justify-between">
                <button type="button" className="text-sm font-semibold text-primary hover:underline" onClick={carrito.abrir}>
                  Editar carrito
                </button>
                <button type="button" className="btn-primario" disabled={!entregaValida} onClick={siguiente}>
                  Continuar al pago <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                </button>
              </div>
            </div>
          )}

          <div className="tarjeta" hidden={paso !== 2}>
            <h2 className="text-lg font-semibold text-on-surface">Método de pago</h2>

            {metodos.length > 1 && (
              <div className={cx('mt-4 grid gap-3', metodos.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
                {metodos.map((m) => (
                  <button
                    key={m.valor}
                    type="button"
                    className={cx(
                      'flex flex-col items-center gap-1.5 rounded-xl border-2 py-4 text-sm font-semibold transition-colors',
                      metodo === m.valor
                        ? 'border-primary bg-surface-container text-primary'
                        : 'border-outline-variant text-on-surface hover:border-primary',
                    )}
                    onClick={() => elegirMetodo(m.valor)}
                  >
                    <span className="material-symbols-outlined text-[28px]">{m.icono}</span>
                    {m.etiqueta}
                  </button>
                ))}
              </div>
            )}

            {alContado && (
              <p className="mt-5 flex items-start gap-2 rounded-lg bg-surface-container-low p-3 text-sm text-on-surface-variant">
                <span className="material-symbols-outlined text-[18px] text-primary">info</span>
                Cobra {monedaBs(total)} en efectivo. Se registra como venta presencial en tu turno de caja abierto.
              </p>
            )}

            {contraentrega && (
              <p className="mt-5 flex items-start gap-2 rounded-lg bg-surface-container-low p-3 text-sm text-on-surface-variant">
                <span className="material-symbols-outlined text-[18px] text-primary">info</span>
                Pagas {monedaBs(total)} en efectivo cuando el repartidor te entregue el pedido. Ten el monto justo si
                puedes.
              </p>
            )}

            {stripeHabilitado && (
              <div hidden={metodo !== 'pasarela'}>
                <div className="mt-5">
                  {preparandoPago && (
                    <div className="flex items-center gap-2 rounded-xl border border-outline-variant p-6 text-sm text-on-surface-variant">
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                      Preparando el pago seguro...
                    </div>
                  )}

                  {errorIntencion && (
                    <div className="rounded-lg border-l-4 border-error bg-error/5 p-3 text-sm text-on-surface" role="alert">
                      <p>
                        <span className="font-semibold text-error">No pudimos preparar el pago.</span> {errorIntencion}
                      </p>
                      <button
                        type="button"
                        className="mt-2 text-sm font-semibold text-primary hover:underline"
                        onClick={sincronizarIntencion}
                      >
                        Reintentar
                      </button>
                    </div>
                  )}

                  <div ref={contenedorPagoRef} hidden={!intencion}></div>

                  {intencion && (
                    <p className="mt-3 flex items-start gap-1 text-xs text-on-surface-variant">
                      <span className="material-symbols-outlined text-[16px]">lock</span>
                      <span>
                        Se cobran {monedaBs(intencion.total_bs)} ({(intencion.monto / 100).toFixed(2)}{' '}
                        {intencion.moneda.toUpperCase()})
                      </span>
                    </p>
                  )}
                </div>
              </div>
            )}

            {!stripeHabilitado && metodo === 'pasarela' && (
              <>
                <p className="mt-1 text-sm text-on-surface-variant">La pasarela no está configurada: el pago queda simulado.</p>
                <div className="mt-5 flex flex-col items-center gap-4 rounded-xl border border-outline-variant p-6 text-center sm:flex-row sm:text-left">
                  <div className="flex h-[160px] w-[160px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white shadow-card">
                    <img src={urlQR} alt="QR de pago" className="h-full w-full" />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-on-surface">Escanea y paga {monedaBs(total)}</p>
                    <p className="mt-1 text-sm text-on-surface-variant">
                      En el entorno de prueba, confirma el pago con el botón.
                    </p>
                    <button
                      type="button"
                      className={cx('mt-4', qrConfirmado ? 'btn-secundario' : 'btn-primario')}
                      onClick={() => setQrConfirmado(true)}
                    >
                      <span className="material-symbols-outlined text-[18px]">{qrConfirmado ? 'check_circle' : 'task_alt'}</span>
                      {qrConfirmado ? 'Pago confirmado' : 'Simular pago confirmado'}
                    </button>
                  </div>
                </div>
              </>
            )}

            <div className="mt-6 flex items-center justify-between">
              <button type="button" className="btn-secundario" onClick={() => irA(1)}>
                <span className="material-symbols-outlined text-[18px]">arrow_back</span> Volver
              </button>
              <button type="button" className="btn-primario" disabled={!pagoListo} onClick={siguiente}>
                Revisar y confirmar <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </button>
            </div>
          </div>

          {paso === 3 && (
            <div className="tarjeta">
              <h2 className="text-lg font-semibold text-on-surface">Confirmación</h2>
              <p className="mt-1 text-sm text-on-surface-variant">Última revisión antes de registrar la compra.</p>

              {errorPago && (
                <div className="mt-4 rounded-lg border-l-4 border-error bg-error/5 p-3 text-sm text-on-surface" role="alert">
                  <span className="font-semibold text-error">No pudimos completar la compra.</span> {errorPago}
                </div>
              )}

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-lg bg-surface-container-low p-3">
                  <dt className="text-on-surface-variant">Productos</dt>
                  <dd className="font-semibold">
                    {carrito.cantidadTotal} {carrito.cantidadTotal === 1 ? 'unidad' : 'unidades'}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4 rounded-lg bg-surface-container-low p-3">
                  <dt className="text-on-surface-variant">Entrega</dt>
                  <dd className="text-right font-semibold">
                    {domicilio ? (
                      <>
                        {entrega.direccion}, {ciudadElegida?.nombre}
                        <span className="block text-xs font-normal text-on-surface-variant">
                          Recibe {entrega.destinatario} · {entrega.telefono}
                        </span>
                      </>
                    ) : (
                      `Retiro en ${carrito.sucursal?.nombre ?? 'la sucursal'}`
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-surface-container-low p-3">
                  <dt className="text-on-surface-variant">Pago</dt>
                  <dd className="font-semibold">{etiquetaPago}</dd>
                </div>
              </dl>

              <div className="mt-6 flex items-center justify-between">
                <button type="button" className="btn-secundario" disabled={pagando} onClick={() => irA(2)}>
                  <span className="material-symbols-outlined text-[18px]">arrow_back</span> Volver
                </button>
                <button type="button" className="btn-primario px-6 py-3 text-base" disabled={pagando} onClick={pagar}>
                  {pagando ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span> Procesando...
                    </>
                  ) : alContado ? (
                    <>
                      <span className="material-symbols-outlined text-[20px]">payments</span> Registrar venta {monedaBs(total)}
                    </>
                  ) : contraentrega ? (
                    <>
                      <span className="material-symbols-outlined text-[20px]">local_shipping</span> Confirmar pedido{' '}
                      {monedaBs(total)}
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-[20px]">lock</span> Pagar {monedaBs(total)}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </section>

        <aside className="lg:col-span-5">
          <div className="tarjeta lg:sticky lg:top-24">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">Tu pedido</h3>
            <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto text-sm">
              {carrito.lineas.map((item) => (
                <li key={item.producto_sucursal_id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate text-on-surface">
                    {item.cantidad} × {item.nombre} <span className="text-on-surface-variant">({item.talla})</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{monedaBs(item.precio_aplicado * item.cantidad)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-4 space-y-1.5 border-t border-outline-variant pt-3 text-sm">
              <div className="flex justify-between text-on-surface-variant">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{monedaBs(carrito.subtotal + carrito.ahorroMayor)}</dd>
              </div>
              {carrito.porMayor && (
                <div className="flex justify-between text-success">
                  <dt>Precio por mayor</dt>
                  <dd className="tabular-nums">−{monedaBs(carrito.ahorroMayor)}</dd>
                </div>
              )}
              <div className="flex justify-between text-on-surface-variant">
                <dt>{domicilio ? `Envío${ciudadElegida ? ` a ${ciudadElegida.nombre}` : ''}` : 'Retiro en sucursal'}</dt>
                <dd className="tabular-nums">
                  {domicilio ? (ciudadElegida ? monedaBs(costoEnvio) : 'Elige la ciudad') : 'Sin costo'}
                </dd>
              </div>
              <div className="flex justify-between border-t border-outline-variant pt-2 text-base font-bold text-on-surface">
                <dt>Total</dt>
                <dd className="tabular-nums">{monedaBs(total)}</dd>
              </div>
            </dl>
            {carrito.sucursal && (
              <p className="mt-3 flex items-center gap-1 text-xs text-on-surface-variant">
                <span className="material-symbols-outlined text-[16px]">store</span>
                {domicilio ? `Despacha ${carrito.sucursal.nombre}` : carrito.sucursal.nombre}
              </p>
            )}
            <Link to="/catalogo" className="mt-4 block text-center text-xs font-semibold text-primary hover:underline">
              Seguir comprando
            </Link>
          </div>
        </aside>
      </div>
    </div>
  )
}
