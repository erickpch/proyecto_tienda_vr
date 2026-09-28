import { http, limpiarParams } from '@/core/api/http'

export const enviosService = {
  listar(filtros = {}) {
    return http.get('/envios', { params: limpiarParams(filtros) })
  },

  obtener(id) {
    return http.get(`/envios/${id}`)
  },

  avanzar(id, estado, nota = null) {
    return http.post(`/envios/${id}/estado`, { estado, nota })
  },

  cancelar(id, motivo) {
    return http.post(`/envios/${id}/cancelacion`, { motivo })
  },
}
