#!/usr/bin/env node
/**
 * Script local para realizar o fluxo OAuth 2.0 do Google Calendar
 * e imprimir o GOOGLE_REFRESH_TOKEN para configurar como secret no Cloudflare Worker.
 *
 * Como usar:
 *   1. No Google Cloud Console (APIs & Services -> Credentials):
 *      - Ative a "Google Calendar API".
 *      - Crie um OAuth 2.0 Client ID (tipo "Web application" ou "Desktop app").
 *      - Em "Authorized redirect URIs", adicione: http://localhost:3000/oauth2callback
 *   2. Rode no terminal:
 *      GOOGLE_CLIENT_ID="seu_client_id" GOOGLE_CLIENT_SECRET="seu_client_secret" node scripts/google-oauth.mjs
 *      (ou apenas `node scripts/google-oauth.mjs` e informe quando solicitado)
 */

import http from 'node:http'
import readline from 'node:readline'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 3000
export const CALLBACK_PATH = '/oauth2callback'
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

export function buildGoogleAuthUrl({
  clientId,
  redirectUri,
  scope = CALENDAR_SCOPE,
  state,
}) {
  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: redirectUri.trim(),
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  })
  if (state) params.set('state', state)
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

export async function exchangeCodeForTokens({
  code,
  clientId,
  clientSecret,
  redirectUri,
  fetcher = fetch,
}) {
  const body = new URLSearchParams({
    code: code.trim(),
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    redirect_uri: redirectUri.trim(),
    grant_type: 'authorization_code',
  })

  const res = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  const data = await res.json()
  if (!res.ok) {
    throw new Error(
      `Falha ao trocar authorization code (${res.status}): ${JSON.stringify(data)}`,
    )
  }
  return data
}

function askQuestion(rl, promptText) {
  return new Promise((resolve) => rl.question(promptText, (ans) => resolve(ans.trim())))
}

function tryOpenBrowser(url) {
  const platform = process.platform
  const cmd =
    platform === 'win32'
      ? `start "" "${url}"`
      : platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, () => {
    // Se falhar, o usuário pode copiar e colar a URL impressa no terminal
  })
}

async function runCli() {
  const port = Number(process.env.OAUTH_PORT) || DEFAULT_PORT
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`

  let clientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim()
  let clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? '').trim()

  if (!clientId || !clientSecret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    if (!clientId) {
      clientId = await askQuestion(rl, 'Informe o GOOGLE_CLIENT_ID: ')
    }
    if (!clientSecret) {
      clientSecret = await askQuestion(rl, 'Informe o GOOGLE_CLIENT_SECRET: ')
    }
    rl.close()
  }

  if (!clientId || !clientSecret) {
    console.error('Erro: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET são obrigatórios.')
    process.exit(1)
  }

  const authUrl = buildGoogleAuthUrl({ clientId, redirectUri })

  console.log('\n=============================================================')
  console.log(' Fluxo OAuth 2.0 — Google Calendar (Refresh Token)')
  console.log('=============================================================')
  console.log(`Certifique-se de que a Redirect URI abaixo está cadastrada no Google Cloud Console:`)
  console.log(`  ${redirectUri}\n`)
  console.log('Abra a URL abaixo no navegador para autorizar sua conta Google:\n')
  console.log(authUrl)
  console.log('\nAguardando retorno em', redirectUri, '...\n')

  tryOpenBrowser(authUrl)

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Rota não encontrada.')
        return
      }

      const error = reqUrl.searchParams.get('error')
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`Autorização recusada: ${error}`)
        console.error('\nErro retornado pelo Google OAuth:', error)
        server.close(() => process.exit(1))
        return
      }

      const code = reqUrl.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Parâmetro "code" ausente na URL de callback.')
        return
      }

      const tokens = await exchangeCodeForTokens({
        code,
        clientId,
        clientSecret,
        redirectUri,
      })

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="background:#0d1117;color:#39d353;font-family:monospace;padding:32px;">' +
          '<h2>✓ Autorização concluída!</h2>' +
          '<p>O <b>GOOGLE_REFRESH_TOKEN</b> foi impresso no terminal. Você já pode fechar esta aba.</p>' +
          '</body></html>',
      )

      console.log('=============================================================')
      console.log(' SUCESSO! Tokens obtidos:')
      console.log('=============================================================\n')
      if (tokens.refresh_token) {
        console.log('GOOGLE_REFRESH_TOKEN=')
        console.log(tokens.refresh_token)
        console.log('\nPara salvar no Cloudflare Worker, rode na pasta /worker:')
        console.log('  npx wrangler secret put GOOGLE_REFRESH_TOKEN')
      } else {
        console.warn(
          'Aviso: Nenhum refresh_token foi retornado. Revogue o acesso do app em https://myaccount.google.com/permissions e rode novamente (com prompt=consent).',
        )
      }
      console.log('=============================================================\n')

      server.close(() => process.exit(0))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Erro ao trocar o código pelo refresh token. Veja o terminal.')
      console.error('\nFalha ao obter tokens:', err)
      server.close(() => process.exit(1))
    }
  })

  server.listen(port)
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  runCli()
}
