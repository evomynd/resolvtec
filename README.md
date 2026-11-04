# Resolv.tec — Gestão predial inteligente

WebApp mobile-first para manutenção predial, com interface em português do Brasil, moeda BRL e fuso `America/Sao_Paulo`.

## Fase atual

**Fase 1 — Base: concluída.** Next.js App Router, TypeScript strict, tema escuro Manrope, login Firebase por Google ou e-mail/senha, custom claims (`role` e `clienteId`), regras Firestore/Storage, seed local e emuladores.

**Fase 2 — Cadastros: implementada, testada e implantada.** Painel `/painel`, cadastros de clientes, unidades, ativos, usuários/técnicos e planos preventivos; callables autenticadas, validação Zod, auditoria, filtros de tenant e exclusão lógica apenas para administrador. Um administrador pode restaurar pelo mesmo e-mail uma conta excluída logicamente; a restauração é auditada e reativa Auth e perfil técnico. O menu Técnicos atribui um ou mais técnicos elegíveis (por cidade) a cada unidade e mostra a carga atual por técnico.

**Execução de planos preventivos: implementada; Functions implantadas.** O checklist do plano aceita tópicos e atividades. O técnico abre cada tópico, registra a foto inicial para começar, marca atividades e observação, e precisa da foto final e de todas as atividades marcadas para concluir. Ao concluir todos os tópicos, a próxima data avança conforme a periodicidade. Execuções e alterações são auditadas; fotos permanecem privadas. Para habilitar uploads no projeto real, o administrador precisa publicar manualmente as Rules atualizadas de Firestore e Storage.

As fases seguintes (ordens de serviço completas, WhatsApp, dashboards, sensores e acabamento) ainda não foram implementadas.

## Requisitos locais

- Node.js 22 ou superior
- npm
- Firebase CLI (instalado como dependência do workspace)

## Configuração local

1. Instale as dependências na raiz: `npm install`.
2. `apps/web/.env.local` está configurado localmente para o projeto Firebase informado pelo usuário. O arquivo é ignorado pelo Git; não o copie para o repositório nem compartilhe seus valores.
3. Antes do login real, habilite Google e e-mail/senha no Authentication e configure as regras no projeto. As Functions da Fase 1 precisam ser implantadas para claims e auditoria.
4. Para usar os emuladores, troque temporariamente os identificadores em `apps/web/.env.local` pelos valores demo de `.env.example` e habilite `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`; inicie `npm run emulators` em outro terminal.
5. Para o seed, defina uma senha local de demonstração (mínimo 12 caracteres) no ambiente e rode `npm run seed:emulators`. O seed é fixado no projeto `demo-resolvtec` e nunca deve ser executado contra produção.
6. Inicie o app: `npm run dev`. Acesse `http://localhost:3000`.

No PowerShell, a senha local pode ser solicitada sem eco e mantida apenas na sessão atual:

```powershell
$secure = Read-Host "Senha local de demonstração" -AsSecureString
$env:RESOLVTEC_SEED_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
npm run seed:emulators
```

O usuário seed usa o e-mail `admin@resolvtec.local`. O perfil inicial e os dados demonstrativos são fictícios. Para entrar, use a senha informada durante o seed.

## Verificações

- `npm run typecheck` — TypeScript strict em shared, Functions e web.
- `npm run lint` — ESLint web e backend.
- `npm run test:emulators` — testes de isolamento Firestore/Storage e callables de cadastro com os emuladores.
- `npm run build` — build shared, Functions e Next.js.

## Firebase e segurança

O alias padrão da Firebase CLI continua sendo `demo-resolvtec`; não é um projeto de produção. O app local usa o projeto `resolvtec-22241` fornecido no `.env.local`, sem apontar para emuladores. Regras negam gravações diretas do navegador: mudanças de perfil e auditoria passam por Cloud Functions. Perfil e tenant vêm dos custom claims assinados pelo Firebase Auth. A função `setUserRole` só aceita chamadas de administrador.

As callables de cadastros e execução preventiva (`listCatalog`, `listTechnicianOptions`, `listTechnicianCoverage`, `assignTechniciansToUnit`, `saveCatalogRecord`, `assignExistingUser`, `softDeleteCatalogRecord`, `updateOwnProfile`, `preparePreventivePhoto`, `startPreventiveTopic`, `updatePreventiveActivity`, `savePreventiveObservation`, `completePreventiveTopic` e `getPreventivePhotoUrl`) passam nos emuladores e estão implantadas em `resolvtec-22241`.

## Primeiro acesso no projeto real

1. No Firebase Console, habilite Google em Authentication → Sign-in method e confirme `localhost` em Authorized domains.
2. Instale um JDK compatível e rode `npm run test:emulators` antes de publicar as regras.
3. Faça o build: `npm run build`.
4. Publique manualmente `firestore.rules` e `storage.rules` no Firebase Console; o assistente não deve implantar Rules pelo CLI.
5. Se necessário, implante somente as Functions com `firebase deploy --only functions --project resolvtec-22241`. Cloud Functions pode exigir o plano Blaze e faturamento ativo.
6. Rode `npm run dev` e entre com a conta Google verificada `leandroalves.facilities@gmail.com`. A callable `bootstrapInitialAdmin` só permite esse e-mail, cria a claim `role=administrador` uma única vez e registra auditoria.

Não compartilhe chaves de service account nem habilite gravações abertas. O bootstrap usa a sessão autenticada e valida o e-mail verificado no backend; não há credencial administrativa no navegador.

Nenhuma credencial de Wafly, IA, gateway IoT ou produção deve ser colocada neste repositório ou no bundle do navegador. Integrações server-side usarão Secret Manager nas fases correspondentes. O logo oficial deverá substituir o ícone vetorial temporário em `/public/icon.svg`; aguarda-se o arquivo `/public/logo.png` da Resolv.tec.

## Decisões mantidas

SLA por porte permanece configurável sem valores presumidos; raio inicial de check-in de 300 m; leituras brutas IoT com retenção configurável (proposta: 90 dias) e agregados horários (proposta: 24 meses); Gemini desligado por padrão. A política definitiva de retenção de fotos/assinaturas e os valores de SLA ainda dependem de validação do negócio.
