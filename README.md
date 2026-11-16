# Meu Treino (PWA)

App web progressivo, mobile-first e em português do Brasil, para registrar **treinos de calistenia**, **dieta** e **medidas corporais** no iPhone. Arquitetura **offline-first**: o Dexie/IndexedDB no aparelho é a fonte de verdade local (funciona 100% offline e sem login), com sincronização opcional em nuvem via **Firebase Auth (e-mail/senha) + Cloud Firestore**.

Stack: Vite + React + TypeScript, `vite-plugin-pwa`, Dexie (IndexedDB), Firebase (Auth + Firestore), Recharts, Vitest + fake-indexeddb.

## Rodar localmente

```bash
npm install
npm run dev        # http://localhost:5173
npm run icons      # (opcional) regenera os ícones em public/
npm run build      # typecheck + build em dist/
npm run preview    # serve o build para testar o PWA/offline
```

Requer Node 18+ (testado com Node 22).

## Testes

```bash
npm test
```

Os testes (`tests/data.test.ts`, `tests/panel.test.ts`, `tests/sync.test.ts`, `tests/lock.test.ts` e `tests/assistant.test.ts`, além de `worker/tests/worker.test.ts`) usam Vitest + `fake-indexeddb` e cobrem: migração de schema (v1 → v2 → v3 e backups antigos), validação de backup, export → import (ida e volta sem perder nada), mesclar vs. substituir, snapshots (criar, restaurar, limite de 5, frequência semanal), atomicidade da importação, fila de envio (outbox), resolução de conflitos Last-Write-Wins, soft delete, fluxo de primeiro login com dados locais (usando mock do Firebase em memória, sem rede), lógica da tranca por Face ID / PIN reserva, e o assistente de IA (execução de ferramentas somente de leitura, validação de rascunhos antes de gravar, ausência de chaves no código, isolamento do histórico do chat e validação JWT/CORS/limites no Worker).

## Deploy no GitHub Pages (passo a passo)

1. Crie um repositório no GitHub (ex.: `meu-treino`) e envie este projeto para a branch `main`:
   ```bash
   git init && git add . && git commit -m "Meu Treino"
   git branch -M main
   git remote add origin https://github.com/USUARIO/NOME-DO-REPO.git
   git push -u origin main
   ```
2. No GitHub: **Settings → Pages → Build and deployment → Source: “GitHub Actions”**.
3. O workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) roda a cada push na `main`: instala, roda os testes, faz o build e publica. Acompanhe na aba **Actions**.
4. O site fica em `https://USUARIO.github.io/NOME-DO-REPO/`.

O `base` do Vite e o `start_url`/`scope` do manifest vêm da variável `BASE_PATH`, que o workflow define automaticamente como `/NOME-DO-REPO/` (o nome do repositório). Localmente o padrão é `/`. Se publicar em domínio próprio na raiz, use `BASE_PATH=/`. Para testar o build como no Pages: `BASE_PATH=/NOME-DO-REPO/ npm run build` (PowerShell: `$env:BASE_PATH='/NOME-DO-REPO/'; npm run build`).

Não há roteador por path: a navegação é por abas em estado, então funciona no Pages sem configuração extra.

## Instalar no iPhone

1. Abra o endereço do site **no Safari**.
2. Toque em **Compartilhar → Adicionar à Tela de Início**.
3. **Abra o app pelo ícone da Tela de Início** e só registre dados por ele. ⚠️ No iPhone, os dados do Safari e do app instalado são **separados**: o que for registrado no Safari antes de instalar não aparece no app instalado (use backup/importação para levar).
4. Abra uma vez com internet; depois disso funciona offline.

## Backup e restauração

Em **Config**:

- **Exportar backup (JSON)**: gera `meu-treino-backup-AAAA-MM-DD.json` com `schemaVersion`, data/hora e todas as tabelas. No iPhone abre a folha de compartilhamento (Web Share com arquivo): escolha **Salvar em Arquivos** → iCloud Drive. Onde não há suporte, faz download normal.
- **Importar backup…**: valida o arquivo e o `schemaVersion`, mostra prévia (treinos, refeições, pesos) e deixa escolher:
  - **Mesclar**: adiciona o que falta; registros com o mesmo id que já existem no aparelho são mantidos.
  - **Substituir tudo**: apaga os dados atuais e usa só o backup. Antes disso é criado um snapshot de segurança automático.
- **Snapshots internos**: um automático por semana de uso (ao abrir o app), mantendo os 5 mais recentes de cada tipo (automático, segurança, manual). Restaure em Config → Snapshots (antes de restaurar cria-se um snapshot de segurança do estado atual). Ficam no próprio aparelho: **não substituem o backup exportado**.
- Um banner avisa quando o último backup exportado tem mais de 7 dias (ou nunca foi feito).
- O status de “armazenamento persistente” e o uso de espaço aparecem em Config; o app chama `navigator.storage.persist()` ao iniciar.

Recomendação: exporte um backup toda semana e guarde no iCloud Drive.

## Estrutura

```
src/
  data/     types, db (Dexie + versões/migrações), backup (export/import/snapshots), seed, stats
  components/  ui (toast/confirm/sheet), SessionEditor, ExerciseViews, Chart, RestTimer
  tabs/     Treino, Dieta, Corpo, Config
scripts/generate-icons.mjs   gera os ícones PNG sem dependências
tests/data.test.ts
```

Para mudar o schema: **nunca edite uma versão publicada**; adicione `this.version(n+1)` em `src/data/db.ts`, incremente `DB_VERSION`, e espelhe a transformação em `parseBackup` (backup.ts) para backups antigos.

## Decisões simples (pontos ambíguos)

- **Um registro corporal por data** (salvar de novo na mesma data atualiza o dia). A média móvel do peso usa os registros dos últimos 7 dias.
- **PR**: maior carga extra; em empate, mais repetições (ou segundos). Volume = total de reps/segundos e “carga” = soma de kg × reps.
- **Refeições**: uma por tipo e dia (café, almoço, jantar, lanches). “Repetir de ontem” copia a refeição do mesmo tipo.
- **Alimentos**: valores por porção de referência; ao adicionar escolhe-se o número de porções. Os ~20 alimentos iniciais são **aproximados e editáveis**.
- **Treino em andamento** é gravado a cada série; se fechar o app, ele continua aberto na aba Treino até finalizar ou descartar.
- **Exclusões** sempre pedem confirmação; treinos, refeições, alimentos, rotinas e registros oferecem “Desfazer” por 6 segundos. Séries são excluídas com confirmação (sem desfazer).
- **Snapshots** não entram no arquivo de backup (evita crescimento) e são separados por tipo.
- Vibração do timer: o Safari do iOS normalmente não suporta `navigator.vibrate`; o app toca um beep (após o primeiro toque na tela). O timer usa o horário final, então fica correto mesmo se a tela apagar, mas o aviso sonoro só toca com o app aberto.
- Exercícios/alimentos iniciais são criados uma vez; se você apagar algum, ele não volta.
- Fotos de progresso: fase 2, não implementadas.

## Design (v2 / refinamento flow-state)

Estética “GitHub dark + terminal”: minimalista, silenciosa e densa. Tokens em `:root` de `src/styles.css`.

- **Paleta**: fundo `#0d1117`, superfície `#161b22`, bordas `#30363d`, texto `#e6edf3` / `#8b949e`. Verde `#39d353` é a única cor de destaque; escala do heatmap `#161b22 → #0e4429 → #006d32 → #26a641 → #39d353`. Vermelho/âmbar só para alertas e metas estouradas.
- **Tokens de arredondamento**:
  - `--radius-sm: 6px` (chips, botões pequenos, statusline, seletores RPE)
  - `--radius-md: 10px` (botões, inputs, selects, células do calendário, toasts, banners)
  - `--radius-lg: 14px` (cards, painéis, folhas modais, cantos superiores da barra inferior, painel de boot e tela de bloqueio)
  - Quadradinhos do heatmap com raio de `3px`. Pílulas redondas (`999px`) são restritas às tags `[PR]` e ao indicador de status de sincronização.
- **Identidade de terminal / flow state**:
  - **Statusline (estilo tmux/vim)** no topo do painel com branch (`main`), versão real do app (`v1.0.<DB_VERSION>`), indicador de tranca (`● locked` / `○ unlocked`), indicador de sincronização em tempo real (`● synced`, `○ pending`, `○ local` ou `○ offline`) e relógio atual (`HH:MM`).
  - **Prompt de comando** nos títulos das abas (`~/treino $`, `~/dieta $`, `~/corpo $`, `~/assistente $`, `~/config $`) com cursor verde piscando (estático quando `prefers-reduced-motion: reduce` está ativo).
  - **Sequência de boot** rápida (máx. 520ms, pulável com um toque) apenas na abertura a frio, exibindo etapas reais (`loading db... ok`, `storage.persist...`, `sync...`) sem bloquear nem atrasar o carregamento.
  - **Tela de bloqueio preparada** (`LockScreen` em `src/components/TerminalChrome.tsx`, classes `.lock-screen` / `.lock-panel`): estética de terminal com `$ auth --biometric`, botão `$ desbloquear` e erros no formato `error: ...`.
  - **Brilho verde sutil** (`--glow: 0 0 8px rgba(57, 211, 83, 0.22)`) restrito a elementos ativos: botão principal, aba ativa e dia de hoje no heatmap/calendário.
- **Tipografia**: JetBrains Mono empacotada localmente (`@fontsource/jetbrains-mono`, pesos 400/600/700, sem CDN → funciona offline), `tabular-nums` em tudo. Hierarquia por tamanho e peso; títulos em minúsculas.
- **Sem emojis**, sem gradientes chamativos. Ícones da barra inferior em SVG (traço 1.5). Sub-abas são texto com sublinhado verde.
- **Safe area e viewport no iOS standalone**: `#root` com `position: fixed; inset: 0; height: var(--vh, 100%)` (sem `100vh`/`100dvh`), `overscroll-behavior: none` e rolagem somente em `.scroll`; `html`, `body` e `#root` compartilham a cor `--surface` na base, `.tabbar` inclui `padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 2px)` e `::after` estendido 220px para baixo, e `--vh` é recalculado em `visibilitychange`, `pageshow`, `resize`, `orientationchange` e `visualViewport.resize`.
- **Movimento**: transições de até 150ms; `prefers-reduced-motion` desliga todas as animações e o piscar do cursor.
- **Modo foco** (durante o treino): tela cheia, um exercício por vez, steppers com botões de 56px, “última vez” ao lado, `$ concluir série`, descanso como contagem regressiva grande com barra fina, sem popups.
- **Log estilo commits**: `chore: treino b concluído` + linhas `feat: flexão diamante 4x12 +10kg [PR]`, com data relativa. `[PR]` aparece quando a série superou todo o histórico anterior do exercício (a primeira vez de um exercício não conta).

### Fórmula do heatmap

Cada dia dos últimos ~6 meses (26 semanas, colunas seg→dom) recebe uma pontuação 0–6 somando três partes (código em `src/lib/panel.ts`):

| Parte | Pontos |
|---|---|
| Treino | 0 sem séries · **2** com ≥ 1 série · **3** com ≥ 12 séries no dia |
| Dieta | 0 sem refeições · **1** com refeições registradas · **2** se, além disso, proteína do dia ≥ meta |
| Peso | **1** se há peso registrado |

Nível (cor): pontuação 0 → nível 0 · 1–2 → 1 · 3 → 2 · 4–5 → 3 · 6 → 4. Tocar num quadradinho mostra o resumo do dia (treino, kcal/proteína, peso).

### Streak

Conta **dias de treino** (sessões com ao menos 1 série). Dois treinos pertencem à mesma sequência se houver no máximo *N* dias de descanso entre eles; *N* é configurável em Config → treino (padrão 2). A sequência atual continua viva enquanto os dias sem treino desde o último não passarem de *N*. “Treinos no mês” e “total no ano” contam sessões com séries no mês/ano corrente. A tolerância é guardada na tabela `settings` (chave `streakGap`).

## Sincronização em nuvem (Firebase Auth + Firestore)

O app continua **offline-first**: todas as leituras e gravações ocorrem imediatamente no IndexedDB (`Dexie`). Se você não fizer login, ele funciona 100% em modo local. Quando logado e online, uma réplica sincronizada é mantida no Firestore em `users/{uid}/records/{table:pk}`.

### Como funciona a sincronização

- **Schema v3 e migração segura**: todos os registros possuem `updatedAt` (timestamp em ms) e `deleted` (booleano para *soft delete*). Ao atualizar de um banco v2 para v3 com dados existentes, o upgrade do Dexie cria automaticamente um snapshot de segurança interno e preenche `updatedAt = agora` e `deleted = false` sem perder nenhum dado.
- **Fila de envio (outbox)**: cada criação, edição ou exclusão local gera uma entrada na tabela `outbox`. Quando online e autenticado, os itens pendentes são enviados em lote (`writeBatch`) com retry automático em caso de falha de rede.
- **Resolução de conflitos (Last-Write-Wins)**: por registro, vence o lado (`local` vs. `nuvem`) com maior `updatedAt`. Exclusões usam *soft delete* (`deleted: true` + novo `updatedAt`) para que a remoção propague para outros aparelhos.
- **Primeiro login com dados locais**: ao entrar pela primeira vez em um aparelho que já tem dados locais registrados, o app **nunca sobrescreve silenciosamente nenhum dos lados**. Ele exibe uma prévia comparando as contagens (`neste aparelho` vs. `na nuvem`), cria um snapshot interno de segurança antes de prosseguir e pergunta se você quer **enviar e mesclar os dados locais com a nuvem** ou **usar apenas os dados da nuvem**.
- **Configurações sincronizadas**: apenas `goals`, `restSeconds` e `streakGap` são sincronizadas; estados efêmeros ou credenciais locais (como sessão ativa, PIN ou Face ID, se existirem) nunca saem do aparelho.

### Como criar/configurar o projeto Firebase

As chaves públicas do web app ficam em [`src/firebaseConfig.ts`](src/firebaseConfig.ts). Caso crie seu próprio projeto:

1. Acesse o [Firebase Console](https://console.firebase.google.com/) e crie um projeto (sem Google Analytics).
2. Em **Build → Authentication → Get started → Sign-in method**, ative **Email/Password** (não use popups/redirects sociais, pois PWAs standalone no iOS isolam o contexto de navegação).
3. Em **Authentication → Settings → Authorized domains**, adicione o domínio onde o app está hospedado:
   - `localhost` (já vem por padrão para desenvolvimento)
   - `USUARIO.github.io` (para GitHub Pages)
4. Em **Build → Firestore Database → Create database**, crie o banco no modo produção.
5. Em **Firestore Database → Rules**, substitua `[SEU_UID]` pelo seu UID real (visível em **Authentication → Users** no console do Firebase) e publique as regras do arquivo [`firestore.rules`](firestore.rules) na raiz do projeto. O documento raiz `/users/{uid}` (onde fica `groqApiKey`, lida apenas pelo Worker) tem escrita bloqueada para clientes (`allow write: if false`), enquanto as subcoleções (`/users/{uid}/records/{id}`) permitem leitura e escrita apenas para o seu UID:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read: if request.auth != null && request.auth.uid == uid && uid == '[SEU_UID]';
         allow write: if false;

         match /records/{id} {
           allow read, write: if request.auth != null && request.auth.uid == uid && uid == '[SEU_UID]';
         }

         match /{subcollection}/{docId=**} {
           allow read, write: if request.auth != null && request.auth.uid == uid && uid == '[SEU_UID]';
         }
       }
     }
   }
   ```

### Criação de contas desativada (e como reativar)

Como o app é de uso estritamente pessoal, o botão/fluxo **"criar conta"** foi removido da interface (`~/config`) e a função `createUserWithEmailAndPassword` foi retirada do código. Na UI, ficam disponíveis apenas **entrar** (e-mail e senha), **sair** e **redefinir senha**, com persistência de sessão local (`indexedDBLocalPersistence` / `browserLocalPersistence`).

- **Como criar ou adicionar uma conta sem mexer no código**: no [Firebase Console](https://console.firebase.google.com/) → **Authentication → Users → Add user**, cadastre seu e-mail e senha manualmente e copie o `User UID` gerado para o `firestore.rules`. Você também pode desativar novos cadastros públicos em **Authentication → Settings → User actions → Enable create (sign-up)**.
- **Como reativar a criação de conta no app**: caso queira voltar a criar conta pela própria tela `~/config`, basta reimportar `createUserWithEmailAndPassword` de `firebase/auth` em `src/data/sync.ts`, readicionar a opção `['signup', 'criar conta']` no seletor `<Seg>` de `src/tabs/Config.tsx` e ajustar `firestore.rules` (removendo a trava `&& request.auth.uid == "[COLE_SEU_UID_AQUI]"` se houver mais de um usuário).

### Limites do plano gratuito (Spark)

O plano gratuito do Firebase (Spark) inclui:
- **Firestore**: 1 GiB de armazenamento, **50.000 leituras/dia**, **20.000 gravações/dia** e **20.000 exclusões/dia**.
- **Authentication**: gratuito para e-mail e senha (até 50.000 MAUs).

Como o app é de uso individual, lê sempre do IndexedDB local e só envia deltas pela fila `outbox` (além de não enviar os ~90 exercícios/alimentos padrão enquanto não forem editados), o consumo típico diário fica na casa de poucas dezenas de operações — menos de 1% da cota gratuita.

### Como recuperar seus dados em um aparelho novo

1. No iPhone novo, abra o endereço do app no Safari, toque em **Compartilhar → Adicionar à Tela de Início** e abra pelo ícone instalado.
2. Vá até a aba **`~/config`**, informe seu **e-mail e senha** e toque em **`$ entrar`**.
3. Como o aparelho novo ainda não tem dados locais registrados, o app baixará automaticamente todos os seus treinos, rotinas, refeições, alimentos personalizados, pesos, medidas e metas da nuvem para o IndexedDB local.
4. Alternativamente, você continua podendo restaurar a qualquer momento um arquivo `.json` exportado pelo botão **`$ importar backup…`** em `~/config`.

## Tranca com Face ID e PIN reserva (WebAuthn local, sem backend)

Em **`~/config` → segurança**, você pode ativar a opção **"bloquear com Face ID"**:

- **Natureza da proteção (tranca de tela, não criptografia em repouso)**: este recurso é um **bloqueio visual de interface** (*screen lock*) para impedir acesso casual quando o iPhone está desbloqueado na mão de outra pessoa. Os registros no IndexedDB local continuam armazenados em texto claro no aparelho (a criptografia de disco é a do próprio iOS).
- **Como funciona o Face ID (WebAuthn)**: ao ativar, o app chama `navigator.credentials.create` com `authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" }` e guarda apenas o `credentialId` (em base64url) na tabela local `settings`. Para desbloquear, o botão **`$ desbloquear`** chama `navigator.credentials.get` sempre a partir de um **toque direto do usuário** (exigência do WebKit/iOS — nunca de forma automática). Em `~/config → segurança`, o app exibe o diagnóstico completo (`estado da tranca`, `credencial WebAuthn` cadastrada ou não e `tempo configurado`) e mostra erros visíveis (`error: ...`) caso o cadastro falhe.
- **Quando o app bloqueia e persistência de timestamps**:
  - **Abertura a frio**: a tranca começa **ativa por padrão** e a `LockScreen` é renderizada antes de qualquer conteúdo (sem exibir dados por baixo nem por um instante).
  - **Retorno de segundo plano (`visibilitychange`, `pageshow`)**: os instantes do último desbloqueio (`lockLastUnlockedAt`) e de ida para segundo plano (`lockHiddenAt`) são salvos em armazenamento persistente (`settings` local + `localStorage`), sobrevivendo mesmo quando o iOS descarta o app da memória. O padrão ao ativar é **"sempre ao abrir (0s)"** (`0` minutos), além das opções de `1`, `5`, `15` até `60` minutos. Quando bloqueado durante uma sessão já aberta, o conteúdo fica oculto (`visibility: hidden`) sem desmontar a árvore principal para não interromper cronômetros de descanso.
- **PIN reserva (4 a 6 dígitos) com PBKDF2 e backoff**: junto com o registro do Face ID, você define um PIN numérico de 4 a 6 dígitos. O PIN puro **nunca** é salvo: o app gera um *salt* aleatório de 16 bytes e deriva um hash `PBKDF2-SHA256` (60.000 iterações via Web Crypto API). Se o Face ID falhar ou for cancelado, você pode desbloquear com o PIN, com atraso crescente após tentativas incorretas (0s na 1ª falha, depois 2s, 4s, 8s, 16s até 30s).
- **Isolamento das chaves de bloqueio**: as chaves `lockEnabled`, `lockCredentialId`, `lockPinHash`, `lockPinSalt`, `lockTimeoutMinutes`, `lockLastUnlockedAt` e `lockHiddenAt` ficam restritas ao aparelho atual — **não** entram em `SYNCABLE_SETTINGS` nem na `outbox` do Firestore, **não** são incluídas no JSON de backup exportado e **não** são apagadas nem sobrescritas ao importar um backup (mesmo no modo *Substituir tudo*).
- **Como recuperar o acesso se perder o Face ID e esquecer o PIN**:
  1. Remova o PWA da Tela de Início do iPhone e adicione-o novamente pelo Safari (isso limpa o IndexedDB local daquele ícone, incluindo a tranca local).
  2. Abra o app reinstalado, vá em **`~/config`** e entre na sua conta Firebase (`$ entrar`) para baixar todos os dados sincronizados da nuvem — ou toque em **`$ importar backup…`** para restaurar seu último arquivo `.json` salvo no iCloud Drive.

## Assistente de IA (Groq via Cloudflare Worker Proxy)

A aba **`~/assistente`** adiciona um coach técnico de calistenia e nutrição conectado aos dados locais do seu aparelho, usando a API do **Groq** (`openai/gpt-oss-120b` com fallback automático para `llama-3.3-70b-versatile`) através de um **Cloudflare Worker** ([`worker/`](worker/README.md)):

- **Chave do Groq no Firestore (`users/{uid}.groqApiKey`), lida só pelo Worker**:
  - A chave da API do Groq fica no documento raiz `users/{uid}` do Firestore, no campo `groqApiKey` (string). O app **nunca** lê esse documento/campo (o motor de sync opera somente na subcoleção `users/{uid}/records/{id}`), e a chave jamais chega ao navegador nem entra no backup JSON.
  - No Worker, após validar o JWT RS256 do Firebase e o `ALLOWED_UID` (`[SEU_UID]`), a chave é buscada via REST (`GET .../documents/users/{uid}`) usando o mesmo ID token do usuário, validada (`começa com "gsk_"`, tamanho válido, sem espaços) e mantida em **cache em memória por `uid` por 5 minutos**.
  - **Como cadastrar ou trocar a chave**: no console do Firebase (**Firestore Database → Data**), edite o campo `groqApiKey` no documento `users/{seu_uid}`. Como `firestore.rules` define `allow write: if false` em `/users/{uid}`, apenas você pelo console pode alterar a chave. Definir `GROQ_API_KEY` via `npx wrangler secret put` continua disponível como fallback opcional.
- **Modelos e raciocínio**:
  - O Worker usa `GROQ_MODEL = "openai/gpt-oss-120b"` com `GROQ_REASONING_EFFORT = "medium"` (enviado como `reasoning_effort` apenas para modelos `gpt-oss`). Se o principal retornar `404`, modelo indisponível ou `5xx`, o Worker tenta uma vez com `GROQ_FALLBACK_MODEL = "llama-3.3-70b-versatile"`. Qualquer campo de raciocínio (`reasoning`) é ignorado, exibindo apenas a resposta final.
- **Function calling somente de leitura no cliente**:
  - As ferramentas (`get_weekly_summary`, `get_exercise_history`, `get_diet_summary`, `get_body_evolution`, `list_exercises_and_routines`) rodam localmente sobre o Dexie e devolvem apenas resumos enxutos (nunca o banco inteiro).
  - Abaixo de cada resposta do assistente, um rodapé informa exatamente quais dados foram enviados naquela consulta.
- **Rascunhos para ações de escrita (zero gravação automática)**:
  - Pedidos para registrar refeição, criar rotina ou registrar peso/medidas usam ferramentas de proposta (`propose_meal`, `propose_routine`, `propose_body_weight`) que exibem um card `[rascunho]` mostrando todos os campos. O registro só é validado e salvo no Dexie quando você toca em **`$ confirmar e salvar`**.
- **Histórico local-only e privacidade**:
  - O histórico do chat fica na chave local `assistantHistory` (excluída do backup JSON, preservada ao importar backups e fora da sincronização com o Firestore), com botão **`$ limpar`** no topo da aba.
  - Veja o passo a passo completo de publicação das regras e deploy do Worker em [`worker/README.md`](worker/README.md) e configure a URL final em [`src/assistantConfig.ts`](src/assistantConfig.ts).



