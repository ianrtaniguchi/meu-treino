# Meu Treino (PWA)

App web progressivo, mobile-first e em português do Brasil, para registrar **treinos de calistenia**, **dieta** e **medidas corporais** no iPhone. É só para uso pessoal: sem login, sem backend, sem analytics e sem serviços externos. **Todos os dados ficam no aparelho** (IndexedDB) e o app funciona 100% offline depois da primeira abertura.

Stack: Vite + React + TypeScript, `vite-plugin-pwa`, Dexie (IndexedDB), Recharts, Vitest + fake-indexeddb.

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

Os testes (`tests/data.test.ts`) usam Vitest + `fake-indexeddb` e cobrem: migração de schema (v1 → v2 e backups antigos), validação de backup, export → import (ida e volta sem perder nada), mesclar vs. substituir, snapshots (criar, restaurar, limite de 5, frequência semanal) e atomicidade da importação.

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
