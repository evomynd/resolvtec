import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const projectId = "demo-resolvtec";
const email = process.env.RESOLVTEC_SEED_ADMIN_EMAIL ?? "admin@resolvtec.local";
const password = process.env.RESOLVTEC_SEED_ADMIN_PASSWORD;

if (!password || password.length < 12) {
  throw new Error("Defina RESOLVTEC_SEED_ADMIN_PASSWORD no ambiente local (mínimo 12 caracteres). Não use uma senha real de produção.");
}

process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

if (getApps().length === 0) initializeApp({ projectId });
const auth = getAuth();
const firestore = getFirestore();

async function ensureAdmin() {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, password, displayName: "Admin Resolv.tec (Demo)" });
  }

  await auth.setCustomUserClaims(user.uid, { role: "administrador" });
  await firestore.collection("usuarios").doc(user.uid).set({
    uid: user.uid,
    nome: "Admin Resolv.tec (Demo)",
    email,
    role: "administrador",
    ativo: true,
    baseLegalTratamento: "execucao_contrato",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const clientRef = firestore.collection("clientes").doc("demo-cliente");
  await clientRef.set({
    clienteId: clientRef.id,
    razaoSocial: "Edifício Alameda (DEMO)",
    cnpj: "00.000.000/0000-00",
    segmento: "Condomínio comercial",
    porteContrato: "B",
    sla: { respostaMinutos: null, solucaoMinutos: null },
    valorHoraTecnicaCentavos: 0,
    valorMensalCentavos: 0,
    ativo: true,
    exemplo: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await firestore.collection("unidades").doc("demo-unidade").set({
    clienteId: clientRef.id,
    nome: "Unidade Centro (DEMO)",
    endereco: { logradouro: "Avenida Exemplo", numero: "100", cidade: "Barueri", uf: "SP" },
    coordenadas: { latitude: -23.505, longitude: -46.879 },
    whatsappAutorizados: [],
    tecnicoUids: [],
    exemplo: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await firestore.collection("ativos").doc("demo-ativo").set({
    clienteId: clientRef.id,
    unidadeId: "demo-unidade",
    sistema: "ar-condicionado",
    tipo: "Equipamento demonstrativo",
    identificacao: "AC-DEMO-01",
    observacoes: "Registro fictício para desenvolvimento nos emuladores.",
    tecnicoUids: [],
    exemplo: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  console.info(`Seed local concluído. Administrador de demonstração: ${email}`);
}

ensureAdmin().catch((error: unknown) => {
  console.error("Falha ao carregar o seed local.", error);
  process.exitCode = 1;
});
