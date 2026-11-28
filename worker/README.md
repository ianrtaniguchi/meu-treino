# Worker Proxy — Assistente Meu Treino (Cloudflare Workers + Groq)

Este Cloudflare Worker atua como um proxy autenticado entre o PWA **Meu Treino** e a API do **Groq** (`https://api.groq.com/openai/v1/chat/completions`), lendo a chave do Groq diretamente do **Firestore** (`users/{uid}.groqApiKey`) no servidor da Cloudflare sem que a chave jamais chegue ao navegador.

## Camadas de Segurança e Modelos

1. **Chave do Groq no Firestore (`users/{uid}.groqApiKey`) lida só pelo Worker**:
   - Após validar o token JWT RS256 do Firebase e confirmar que `sub === ALLOWED_UID`, o Worker busca a chave via API REST do Firestore:
     `GET https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}/databases/(default)/documents/users/{uid}`
     usando o mesmo `Authorization: Bearer <ID token>` do usuário.
   - A chave é validada (`começa com "gsk_"`, tamanho válido, sem espaços) e guardada em **cache na memória do isolate por `uid` com TTL de 5 minutos**, evitando consultar o Firestore a cada mensagem.
   - Se o documento/campo não existir, estiver em formato inválido ou o Firestore recusar, o Worker responde `503` com a mensagem genérica `{"error": "chave do assistente não configurada"}`.
   - A chave nunca é registrada em logs, nunca é devolvida na resposta e nunca entra em mensagens de erro.
   - `env.GROQ_API_KEY` (definido via `wrangler secret put`) permanece como **fallback opcional**: se existir, o Worker o utiliza; caso contrário, lê do Firestore.
2. **Modelo principal (`openai/gpt-oss-120b`) + Fallback (`llama-3.3-70b-versatile`)**:
   - `GROQ_MODEL = "openai/gpt-oss-120b"` com `GROQ_REASONING_EFFORT = "medium"` (valores aceitos pela API do Groq: `"low"`, `"medium"`, `"high"`, enviados apenas para modelos `gpt-oss`).
   - Se o modelo principal retornar `404`, erro de modelo indisponível ou `5xx`, o Worker tenta automaticamente uma vez com `GROQ_FALLBACK_MODEL = "llama-3.3-70b-versatile"`.
   - Campos de raciocínio interno (`reasoning`, `reasoning_content`) são descartados antes de devolver a resposta ao app.
3. **Autenticação JWT (Firebase ID Token)**:
   - Exige `Authorization: Bearer <Firebase ID Token>`.
   - Verifica a assinatura `RS256` via Web Crypto API usando as chaves públicas oficiais do Google (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`), com cache respeitando `Cache-Control: max-age`.
   - Valida `iss = https://securetoken.google.com/meu-treino-2007`, `aud = meu-treino-2007`, `exp` vigente, `iat` válido e `sub === ALLOWED_UID` (`[SEU_UID]`). Qualquer outro UID recebe `403`.
4. **CORS restrito e limites**:
   - Permite apenas `https://ianrtaniguchi.github.io` e `http://localhost:5173` (via `ALLOWED_ORIGINS`).
   - Aceita apenas `POST /chat` com corpo JSON de até **64 KB**, somente com os campos `messages`, `tools`, `tool_choice`, `temperature`, `max_tokens` (teto `1024`) e `stream`. O cliente não pode escolher o modelo (`model` no corpo retorna `400`).
   - Rate limiting por UID (`RATE_LIMIT_PER_MIN`, padrão `20 req/min`).

## Fotos e sugestões contextuais do Assistente

- `POST /analyze-assistant-photo` recebe `{ "image": "data:image/jpeg;base64,...", "text": "..." }`, exige Firebase ID Token e aplica a cota diária já usada pelas análises de foto (30 para o proprietário e 10 para contas secundárias). A resposta contém somente uma proposta validada de refeição, gasto, evento ou uma indicação de que a imagem não pôde ser interpretada; o app só grava a proposta depois da confirmação explícita. Gastos e Agenda são restritos ao `OWNER_UID`. Imagens não são armazenadas pelo Worker nem adicionadas ao histórico local. Para recibos, nunca envie números de cartão, CPF ou dados bancários no texto opcional; a resposta exclui OCR bruto e campos identificadores.
- `POST /suggestions` recebe contexto agregado do dia (`timeOfDay`, `workoutLogged` e `mealsLogged`), mais contagens de prazos/gastos somente para o proprietário. O Worker valida e limita esses campos e mantém sugestões em cache curto por UID e horário; não envie nomes, notas, valores de compra ou outros dados pessoais.
- As duas rotas seguem a autenticação, allowlist de UIDs e CORS configurados acima. Após alterações nessas rotas, publique o Worker a partir desta pasta com `npm run deploy`.

## Passo a Passo de Configuração e Deploy

### 1. Cadastrar ou trocar a chave `groqApiKey` no Firestore
1. Crie sua chave em [console.groq.com/keys](https://console.groq.com/keys) (formato `gsk_...`).
2. Abra o [Firebase Console](https://console.firebase.google.com/) → **Firestore Database → Data**.
3. Na coleção `users`, crie (ou abra) o documento cujo ID seja exatamente o seu **User UID** (`users/{uid}`).
4. Adicione o campo:
   - **Field**: `groqApiKey`
   - **Type**: `string`
   - **Value**: `gsk_sua_chave_aqui`
5. **Como trocar a chave no futuro**: basta editar o campo `groqApiKey` nesse mesmo documento `users/{uid}` pelo console do Firebase. Em até 5 minutos (TTL do cache do Worker), a nova chave passará a ser usada automaticamente, sem precisar fazer redeploy do Worker nem do app.

### 2. Publicar as regras do Firestore (`firestore.rules`)
No arquivo [`firestore.rules`](../firestore.rules) na raiz do repositório, substitua `[SEU_UID]` pelo seu User UID real e publique no Firebase Console (**Firestore Database → Rules**). As regras permitem:
- Em `/users/{uid}` (documento raiz onde fica `groqApiKey`): `allow read` apenas para o seu próprio UID (usado pelo Worker) e `allow write: if false` (nenhum cliente pode alterar ou apagar sua chave).
- Em `/users/{uid}/records/{id}` e demais subcoleções: `allow read, write` apenas para o seu próprio UID.

### 3. Configurar seu UID no `wrangler.toml`
Abra [`worker/wrangler.toml`](wrangler.toml) e substitua `[SEU_UID]` pelo seu **User UID** do Firebase Authentication:

```toml
ALLOWED_UID = "seu_uid_real_do_firebase"
```

### 4. Fazer login e publicar o Worker
No terminal, dentro da pasta `worker/`:

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

> **Opcional (`wrangler secret put`)**: como a chave já é lida do Firestore (`users/{uid}.groqApiKey`), você **não** precisa rodar `npx wrangler secret put GROQ_API_KEY`. Caso queira configurar um secret fixo na Cloudflare como override/fallback, o comando continua suportado.

### 5. Configurar a URL final no App
Copie a URL exibida ao final do `npx wrangler deploy` (ex.: `https://meu-treino-assistant.SEU-SUBDOMINIO.workers.dev`) e atualize `ASSISTANT_WORKER_URL` em [`src/assistantConfig.ts`](../src/assistantConfig.ts).

## Rodar testes localmente

```bash
npm test
```
