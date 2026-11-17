export const DEFAULT_PORT: number
export const CALLBACK_PATH: string
export const GOOGLE_AUTH_ENDPOINT: string
export const GOOGLE_TOKEN_ENDPOINT: string
export const CALENDAR_SCOPE: string

export function buildGoogleAuthUrl(options: {
  clientId: string
  redirectUri: string
  scope?: string
  state?: string
}): string

export function exchangeCodeForTokens(options: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetcher?: typeof fetch
}): Promise<{
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}>
