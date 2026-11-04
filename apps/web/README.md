# Resolv.tec Web

Frontend do monorepo Resolv.tec, em Next.js App Router, React, TypeScript strict e Tailwind CSS. Use os comandos na raiz do workspace para manter o build do pacote compartilhado em sincronia.

## Desenvolvimento local

1. Configure `apps/web/.env.local` a partir do `.env.example` da raiz.
2. Inicie os emuladores Firebase na raiz com `npm run emulators`.
3. Inicie a interface na raiz com `npm run dev`.

O login usa Firebase Authentication (e-mail/senha). O bundle web nunca define perfis; `role` e `clienteId` são lidos de custom claims assinadas. As escritas são realizadas por Cloud Functions e as regras do Firestore/Storage permanecem autoritativas.

## Comandos

Executados a partir da raiz: `npm run dev`, `npm run typecheck`, `npm run lint` e `npm run build`.

O manifesto PWA e um ícone vetorial temporário estão em `public/`; substituir o ícone pelo material oficial quando o logo da empresa for fornecido.
