/**
 * Configuração do endpoint do Cloudflare Worker para o Assistente de IA.
 * Substitua pela URL gerada após rodar `npx wrangler deploy` na pasta `worker/`.
 *
 * IMPORTANTE: Nenhuma chave da API do Groq deve existir neste arquivo ou no app.
 */
export const ASSISTANT_WORKER_URL =
  "https://meu-treino-assistant.iantreino.workers.dev";

/**
 * Chave pública VAPID do Firebase Cloud Messaging (Web Push).
 * Gere no Console do Firebase → Configurações do projeto → Cloud Messaging → Certificados de envio por push da Web.
 * É uma chave pública (seguro ficar no cliente); também pode ser definida via VITE_FCM_VAPID_KEY.
 */
export const FCM_VAPID_KEY: string =
  (import.meta as any).env?.VITE_FCM_VAPID_KEY ??
  "BIWNnUuZqXzqwI2eu2pBBMG1UNRL85BhK1Dnv8Sd1rjFMu_qYuvUELOEosD4jAoeAnoeIK7VFe4eAzTWpM_r9Sk";
