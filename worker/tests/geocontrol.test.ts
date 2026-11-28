import { describe, expect, it } from 'vitest'
import {
  GEOCONTROL_BASE_URL,
  GEOCONTROL_ENDPOINTS,
  handleGeocontrolProxyRequest,
} from '../src/ceturb'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://example.test',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

describe('Geocontrol proxy allowlist', () => {
  it.each(GEOCONTROL_ENDPOINTS)('forwards the allowed endpoint %s', async (endpoint) => {
    let forwardedUrl = ''
    let forwardedInit: RequestInit | undefined
    const fetcher: typeof fetch = async (input, init) => {
      forwardedUrl = String(input)
      forwardedInit = init
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const response = await handleGeocontrolProxyRequest(
      new URL(`https://worker.test/geocontrol/${endpoint}`),
      new Request(`https://worker.test/geocontrol/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ probe: true }),
      }),
      corsHeaders,
      { fetcher },
    )

    expect(response.status).toBe(200)
    expect(forwardedUrl).toBe(`${GEOCONTROL_BASE_URL}/${endpoint}`)
    expect(forwardedInit?.method).toBe('POST')
    expect(new Headers(forwardedInit?.headers).get('Content-Type')).toBe('application/json')
    expect(forwardedInit?.body).toBe(JSON.stringify({ probe: true }))
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      corsHeaders['Access-Control-Allow-Origin'],
    )
    if (endpoint === 'obterEstimativasPorOrigem' || endpoint === 'obterUltimaPosicaoDoVeiculo') {
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('rejects endpoints outside the allowlist without contacting the upstream', async () => {
    let requested = false
    const fetcher: typeof fetch = async () => {
      requested = true
      return new Response(JSON.stringify({ ok: true }))
    }
    const endpoint = 'proximaRota'
    const url = new URL(`https://worker.test/geocontrol/${endpoint}`)

    const response = await handleGeocontrolProxyRequest(
      url,
      new Request(url, { method: 'POST', body: '{}' }),
      corsHeaders,
      { fetcher },
    )

    expect(response.status).toBe(403)
    expect(requested).toBe(false)
  })

  it('returns 400 when the endpoint segment is missing', async () => {
    const response = await handleGeocontrolProxyRequest(
      new URL('https://worker.test/geocontrol/'),
      new Request('https://worker.test/geocontrol/', { method: 'POST', body: '{}' }),
      corsHeaders,
    )

    expect(response.status).toBe(400)
  })
})
