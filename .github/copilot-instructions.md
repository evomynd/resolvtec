# Instruções do workspace — Resolv.tec

## Produto e stack
- Plataforma de gestão de manutenção predial para a Região Metropolitana Oeste de São Paulo.
- Interface e dados em português do Brasil; datas em `America/Sao_Paulo`; moeda BRL.
- TypeScript strict em `apps/web`, `functions` e `packages/shared`.
- Frontend: Next.js App Router, Tailwind CSS, componentes compatíveis com shadcn/ui, Firebase Web SDK, React Hook Form, Zod, TanStack Query e Recharts.
- Backend: Cloud Functions 2ª geração, Firebase Admin SDK, Firestore, Storage e Secret Manager para segredos de integrações.

## Identidade e acessibilidade
- Tema escuro padrão: fundo `#101314`, superfícies `#171b1d`, bordas `#2a3033`, texto `#f3f5f4` e destaque `#A4F101`.
- Fonte Manrope. Usar `/public/logo.png` quando o arquivo oficial for fornecido; não inventar a marca.
- Manter foco visível, contraste acessível e respeitar `prefers-reduced-motion`.
- Priorizar uso móvel, especialmente no fluxo do técnico.

## Segurança obrigatória
- Autorização sempre validada por custom claims (`role` e, para cliente, `clienteId`), Firestore/Storage Rules e Functions; nunca confiar somente na interface.
- Clientes só acessam documentos do próprio `clienteId`. Técnicos só acessam OS atribuídas e recursos vinculados a elas.
- Analistas não excluem registros. Exclusões de negócio são lógicas e auditadas; negar exclusão física.
- Não colocar segredos em código, navegador ou repositório. Integrações server-side devem usar Secret Manager; `.env.example` contém somente placeholders.
- Manter mídia privada e servir downloads por URLs assinadas de curta duração.

## Fluxo de desenvolvimento
- Trabalhar uma fase por vez e não iniciar a próxima sem aprovação explícita do usuário.
- Ao terminar uma fase, rodar `npm run typecheck`, `npm run lint` e os testes aplicáveis; resumir pendências e aguardar aprovação.
- Alterar arquivos com as ferramentas de edição do workspace, sem comandos de shell para editar código.
- Antes de usar endpoints de terceiros, consultar documentação pública e implementar apenas rotas documentadas.
- Manter exemplos de desenvolvimento fictícios e limitar seeds aos emuladores.

## Comandos do monorepo
- `npm run dev`: inicia o Next.js.
- `npm run emulators`: inicia Firebase Emulator Suite.
- `npm run seed:emulators`: carrega o seed fictício; exige Auth/Firestore emuladores e senha local no ambiente.
- `npm run typecheck`, `npm run lint`, `npm run test:emulators` e `npm run build`: verificações principais.

## Status do setup
- Concluídos: requisitos definidos, scaffold, tema/login/claims, regras iniciais, seed local, emuladores configurados e documentação inicial.
- Extensões: nenhuma extensão adicional foi exigida.
- Task de execução: dispensável; os comandos estão documentados no `README.md`.
- JDK 21 instalado em escopo de usuário; os testes Firestore/Storage e callables passam no Emulator Suite (12 testes).
- Fase atual: Fase 2 (cadastros e atribuição técnica) implementada e validada localmente. Aguardar aprovação antes da Fase 3.
- As alterações atuais de cadastro técnico precisam de deploy das Functions no projeto real; Rules são publicadas manualmente pelo usuário.
