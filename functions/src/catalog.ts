import { createHash, randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

if (getApps().length === 0) initializeApp();
const firestore = getFirestore();
const callableOptions = { region: "southamerica-east1", maxInstances: 10, invoker: "public" as const };
const defaultTechnicianCities = ["Barueri", "Santana de Parnaíba", "Osasco", "Itapevi"];
const catalogEntitySchema = z.enum([
  "clientes",
  "unidades",
  "ativos",
  "tecnicos",
  "planosPreventivos",
]);
const listEntitySchema = z.enum([
  "clientes",
  "unidades",
  "ativos",
  "tecnicos",
  "planosPreventivos",
  "usuarios",
]);
const deletableEntitySchema = z.enum([
  "clientes",
  "unidades",
  "ativos",
  "tecnicos",
  "planosPreventivos",
  "usuarios",
]);
const sistemaSchema = z.enum([
  "ar-condicionado",
  "eletrica",
  "iluminacao-emergencia",
  "hidraulica",
  "outro",
]);
const especialidadeSchema = z.enum([
  "ar-condicionado",
  "eletrica",
  "hidraulica",
  "civil",
]);
const e164Schema = z.string().regex(/^\+\d{10,15}$/, "Telefone deve estar em E.164.");
const nonNegativeInteger = z.number().int().min(0);
const checklistIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const preventiveTopicSchema = z.object({
  id: checklistIdSchema,
  titulo: z.string().trim().min(1).max(120),
  atividades: z.array(z.object({
    id: checklistIdSchema,
    descricao: z.string().trim().min(1).max(300),
  })).min(1).max(100),
});
const preventiveTopicListSchema = z.array(preventiveTopicSchema).min(1).max(30).superRefine((topics, context) => {
  const topicIds = new Set<string>();
  topics.forEach((topic, topicIndex) => {
    if (topicIds.has(topic.id)) context.addIssue({ code: "custom", path: [topicIndex, "id"], message: "Topic IDs must be unique." });
    topicIds.add(topic.id);
    const activityIds = new Set<string>();
    topic.atividades.forEach((activity, activityIndex) => {
      if (activityIds.has(activity.id)) context.addIssue({ code: "custom", path: [topicIndex, "atividades", activityIndex, "id"], message: "Activity IDs must be unique within a topic." });
      activityIds.add(activity.id);
    });
  });
});
const preventiveChecklistSchema = z.union([
  preventiveTopicListSchema,
  z.array(z.string().trim().min(1).max(300)).min(1).max(100),
]).transform((checklist) => typeof checklist[0] === "string"
  ? [{
    id: "topico-geral",
    titulo: "Checklist geral",
    atividades: checklist.map((descricao, index) => ({ id: `atividade-${index + 1}`, descricao: String(descricao) })),
  }]
  : checklist);
const contactSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  email: z.string().trim().email().optional().or(z.literal("")),
  telefone: e164Schema.optional().or(z.literal("")),
});

const recordSchemas = {
  clientes: z.object({
    razaoSocial: z.string().trim().min(2).max(180),
    cnpj: z.string().regex(/^\d{14}$/, "CNPJ deve conter 14 dígitos."),
    segmento: z.string().trim().min(1).max(100),
    porteContrato: z.enum(["A", "B", "C"]),
    sla: z.object({
      respostaMinutos: nonNegativeInteger,
      solucaoMinutos: nonNegativeInteger,
    }),
    valorHoraTecnicaCentavos: nonNegativeInteger,
    valorMensalCentavos: nonNegativeInteger,
    contatos: z.array(contactSchema).default([]),
    ativo: z.boolean().default(true),
  }),
  unidades: z.object({
    clienteId: z.string().trim().min(1),
    nome: z.string().trim().min(1).max(120),
    endereco: z.object({
      logradouro: z.string().trim().min(1),
      numero: z.string().trim().min(1),
      complemento: z.string().trim().optional(),
      bairro: z.string().trim().optional(),
      cep: z.string().trim().min(8),
      cidade: z.string().trim().min(1),
      uf: z.string().trim().length(2),
    }),
    coordenadas: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }).optional(),
    responsaveis: z.array(contactSchema).default([]),
    whatsappAutorizados: z.array(e164Schema).default([]),
    ativo: z.boolean().default(true),
  }),
  ativos: z.object({
    clienteId: z.string().trim().min(1),
    unidadeId: z.string().trim().min(1),
    sistema: sistemaSchema,
    tipo: z.string().trim().min(1).max(120),
    identificacao: z.string().trim().min(1).max(100),
    observacoes: z.string().trim().max(2000).optional(),
    sensoresIds: z.array(z.string().min(1)).default([]),
    tecnicoUids: z.array(z.string().min(1)).default([]),
    ativo: z.boolean().default(true),
  }),
  tecnicos: z.object({
    usuarioUid: z.string().trim().min(1),
    whatsapp: e164Schema,
    cidadesAtendidas: z.array(z.string().trim().min(1)).min(1),
    especialidades: z.array(especialidadeSchema).min(1),
    ativo: z.boolean().default(true),
  }),
  planosPreventivos: z.object({
    clienteId: z.string().trim().min(1),
    unidadeId: z.string().trim().min(1),
    ativoId: z.string().trim().optional(),
    sistema: sistemaSchema,
    periodicidade: z.enum(["semanal", "quinzenal", "mensal", "bimestral", "trimestral", "semestral", "anual"]),
    checklist: preventiveChecklistSchema,
    tecnicoId: z.string().trim().optional(),
    equipeId: z.string().trim().optional(),
    proximaExecucao: z.string().date(),
    ativo: z.boolean().default(true),
  }),
} satisfies Record<z.infer<typeof catalogEntitySchema>, z.ZodType>;

const listInputSchema = z.object({ entity: listEntitySchema });
const saveInputSchema = z.object({
  entity: catalogEntitySchema,
  id: z.string().trim().min(1).optional(),
  record: z.unknown(),
});
const assignUserSchema = z.object({
  email: z.string().trim().email(),
  nome: z.string().trim().min(1).max(120),
  telefone: e164Schema.optional(),
  role: z.enum(["administrador", "analista", "tecnico", "cliente"]),
  clienteId: z.string().trim().min(1).optional(),
  cidadesAtendidas: z.array(z.string().trim().min(1).max(80)).optional(),
  especialidades: z.array(especialidadeSchema).optional(),
  outraCidade: z.string().trim().max(80).optional(),
}).superRefine((profile, context) => {
  if (profile.role === "tecnico") {
    if (!profile.telefone) context.addIssue({ code: "custom", path: ["telefone"], message: "WhatsApp do técnico é obrigatório." });
    if (!(profile.cidadesAtendidas?.length || profile.outraCidade)) {
      context.addIssue({ code: "custom", path: ["cidadesAtendidas"], message: "Selecione ao menos uma cidade atendida." });
    }
    if (!profile.especialidades?.length) {
      context.addIssue({ code: "custom", path: ["especialidades"], message: "Selecione ao menos uma especialidade." });
    }
  } else if (profile.cidadesAtendidas?.length || profile.especialidades?.length || profile.outraCidade) {
    context.addIssue({ code: "custom", path: ["role"], message: "Cidades e especialidades só podem ser informadas para o perfil Técnico." });
  }
});
const deleteInputSchema = z.object({
  entity: deletableEntitySchema,
  id: z.string().trim().min(1),
});
const assignTechniciansSchema = z.object({
  unidadeId: z.string().trim().min(1),
  tecnicoUids: z.array(z.string().trim().min(1)).max(20),
});
const ownProfileSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  telefone: e164Schema.optional(),
});
const preparePreventivePhotoSchema = z.object({
  planoId: z.string().trim().min(1),
  topicoId: checklistIdSchema,
  etapa: z.enum(["antes", "depois"]),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});
const preventiveTopicActionSchema = z.object({
  planoId: z.string().trim().min(1),
  execucaoId: z.string().trim().min(1),
  topicoId: checklistIdSchema,
});
const preventiveActivitySchema = preventiveTopicActionSchema.extend({
  atividadeId: checklistIdSchema,
  concluida: z.boolean(),
});
const preventiveObservationSchema = preventiveTopicActionSchema.extend({
  observacao: z.string().trim().max(2000),
});
const preventivePhotoUrlSchema = preventiveTopicActionSchema.extend({ etapa: z.enum(["antes", "depois"]) });

type CatalogEntity = z.infer<typeof catalogEntitySchema>;
type ListEntity = z.infer<typeof listEntitySchema>;
type DeletableEntity = z.infer<typeof deletableEntitySchema>;
type RecordMap = Record<string, unknown>;

function requireAuth(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na plataforma para continuar.");
  return request.auth;
}

function requireStaff(role: unknown) {
  if (role !== "administrador" && role !== "analista") {
    throw new HttpsError("permission-denied", "Este perfil não pode acessar os cadastros da operação.");
  }
  return role;
}

function serialize(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

async function assertActiveClient(clienteId: string) {
  const client = await firestore.collection("clientes").doc(clienteId).get();
  if (!client.exists || client.data()?.deletedAt) {
    throw new HttpsError("failed-precondition", "Selecione um cliente ativo.");
  }
}

function normalizeCity(city: string) {
  return city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

type PreventiveTopic = z.infer<typeof preventiveTopicSchema>;
type PreventiveTopicState = {
  status: "aguardando_foto_antes" | "em_andamento" | "concluido";
  atividadesConcluidas: Record<string, boolean>;
  observacao: string;
  fotoAntesPendentePath?: string;
  fotoDepoisPendentePath?: string;
  fotoAntesPath?: string;
  fotoDepoisPath?: string;
  iniciadoPor?: string;
  iniciadoEm?: unknown;
  concluidoEm?: unknown;
  atualizadoEm?: unknown;
};

function normalizePreventiveChecklist(value: unknown): PreventiveTopic[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (value.every((item) => typeof item === "string")) {
    return [{
      id: "topico-geral",
      titulo: "Checklist geral",
      atividades: value.map((item, index) => ({ id: `atividade-${index + 1}`, descricao: String(item) })),
    }];
  }
  return value.flatMap((item) => {
    const parsed = preventiveTopicSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function preventiveExecutionId(planId: string, dueDate: string) {
  const planHash = createHash("sha256").update(planId).digest("hex").slice(0, 40);
  return `${planHash}_${dueDate.replace(/-/g, "")}`;
}

function preventiveDueDate(plan: RecordMap) {
  const value = plan.proximaExecucao;
  const date = value instanceof Timestamp ? value.toDate().toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("failed-precondition", "O plano preventivo não tem uma data de execução válida.");
  }
  return date;
}

function nextPreventiveDueDate(dueDate: string, periodicity: unknown) {
  const dayIntervals: Record<string, number> = { semanal: 7, quinzenal: 14 };
  if (typeof periodicity === "string" && dayIntervals[periodicity]) {
    const date = new Date(`${dueDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + dayIntervals[periodicity]);
    return date.toISOString().slice(0, 10);
  }
  const monthIntervals: Record<string, number> = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12 };
  const monthOffset = typeof periodicity === "string" ? monthIntervals[periodicity] : undefined;
  if (!monthOffset) throw new HttpsError("failed-precondition", "Periodicidade do plano preventivo inválida.");
  const date = new Date(`${dueDate}T00:00:00.000Z`);
  const absoluteMonth = date.getUTCFullYear() * 12 + date.getUTCMonth() + monthOffset;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  date.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
  return date.toISOString().slice(0, 10);
}

async function assertTechnicianPlanAccess(uid: string, planId: string) {
  const user = await getAuth().getUser(uid).catch(() => null);
  if (!user || user.disabled || user.customClaims?.role !== "tecnico") {
    throw new HttpsError("permission-denied", "Somente técnicos ativos podem executar o plano.");
  }
  const planSnapshot = await firestore.collection("planosPreventivos").doc(planId).get();
  const plan = planSnapshot.data();
  if (!planSnapshot.exists || !plan || plan.deletedAt || plan.ativo === false) {
    throw new HttpsError("not-found", "Plano preventivo ativo não encontrado.");
  }
  const unitSnapshot = await firestore.collection("unidades").doc(String(plan.unidadeId ?? "")).get();
  const unit = unitSnapshot.data();
  if (!unitSnapshot.exists || !unit || unit.deletedAt || unit.ativo === false) {
    throw new HttpsError("failed-precondition", "A unidade do plano está inativa ou não foi encontrada.");
  }
  const assignedUids = Array.isArray(unit.tecnicoUids) ? unit.tecnicoUids : [];
  if (plan.tecnicoId !== uid && !assignedUids.includes(uid)) {
    throw new HttpsError("permission-denied", "Este plano não está atribuído ao seu perfil técnico.");
  }
  const checklist = normalizePreventiveChecklist(plan.checklist);
  if (!checklist.length) throw new HttpsError("failed-precondition", "O plano não contém tópicos válidos no checklist.");
  return { plan: plan as RecordMap, unit: unit as RecordMap, checklist };
}

function executionTopic(execution: RecordMap, topicId: string): PreventiveTopicState | null {
  const topics = execution.topicos && typeof execution.topicos === "object" ? execution.topicos as Record<string, unknown> : {};
  const topic = topics[topicId];
  return topic && typeof topic === "object" ? topic as PreventiveTopicState : null;
}

function auditExecutionChange(
  actorUid: string,
  executionId: string,
  topicId: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  return {
    atorUid: actorUid,
    acao: action,
    alvo: { colecao: "execucoesPreventivas", id: executionId, topicoId: topicId },
    antes: serialize(before),
    depois: serialize(after),
    criadoEm: FieldValue.serverTimestamp(),
  };
}

async function getTechnicianCities() {
  const config = await firestore.collection("configuracoes").doc("cidadesTecnicos").get();
  const rawCustomCities: unknown = config.data()?.customCidades;
  const customCities = Array.isArray(rawCustomCities)
    ? rawCustomCities.filter((city): city is string => typeof city === "string")
    : [];
  const cities = [...defaultTechnicianCities, ...customCities];
  return [...new Map(cities.map((city) => [normalizeCity(city), city])).values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

async function assertRelatedRecords(entity: CatalogEntity, record: RecordMap, id: string) {
  if (entity === "unidades") {
    await assertActiveClient(String(record.clienteId));
  }

  if (entity === "ativos" || entity === "planosPreventivos") {
    const clienteId = String(record.clienteId);
    const unidadeId = String(record.unidadeId);
    await assertActiveClient(clienteId);
    const unit = await firestore.collection("unidades").doc(unidadeId).get();
    if (!unit.exists || unit.data()?.deletedAt || unit.data()?.clienteId !== clienteId) {
      throw new HttpsError("failed-precondition", "A unidade não pertence ao cliente selecionado ou está inativa.");
    }
    if (entity === "ativos") {
      const assignedTechnicians = unit.data()?.tecnicoUids;
      record.tecnicoUids = Array.isArray(assignedTechnicians) ? assignedTechnicians : [];
    }
    if (entity === "planosPreventivos" && typeof record.ativoId === "string" && record.ativoId) {
      const asset = await firestore.collection("ativos").doc(record.ativoId).get();
      if (!asset.exists || asset.data()?.deletedAt || asset.data()?.unidadeId !== unidadeId) {
        throw new HttpsError("failed-precondition", "O ativo não pertence à unidade selecionada ou está inativo.");
      }
    }
  }

  if (entity === "tecnicos") {
    try {
      await getAuth().getUser(String(record.usuarioUid));
    } catch {
      throw new HttpsError("failed-precondition", "O usuário precisa entrar no Firebase Authentication antes de ser cadastrado como técnico.");
    }
    if (id !== String(record.usuarioUid)) {
      throw new HttpsError("invalid-argument", "O ID do cadastro técnico deve ser o UID do usuário.");
    }
  }
}

async function readStaffCatalog(entity: ListEntity) {
  const snapshot = await firestore.collection(entity).limit(250).get();
  const activeDocs = snapshot.docs.filter((document) => !document.data().deletedAt);
  if (entity !== "usuarios") {
    return activeDocs.map((document) => ({ id: document.id, ...serialize(document.data()) as RecordMap }));
  }
  return Promise.all(activeDocs.map(async (document) => {
    const profile = document.data();
    if (profile.role !== "tecnico") return { id: document.id, ...serialize(profile) as RecordMap };
    const technician = await firestore.collection("tecnicos").doc(document.id).get();
    return {
      id: document.id,
      ...serialize(profile) as RecordMap,
      ...serialize(technician.data() ?? {} as RecordMap) as RecordMap,
    };
  }));
}

export const listTechnicianOptions = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  requireStaff(auth.token.role);
  return { cidades: await getTechnicianCities() };
});

export const listTechnicianCoverage = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  requireStaff(auth.token.role);
  const [clientSnapshot, unitSnapshot, technicianSnapshot, userSnapshot] = await Promise.all([
    firestore.collection("clientes").limit(250).get(),
    firestore.collection("unidades").limit(500).get(),
    firestore.collection("tecnicos").limit(250).get(),
    firestore.collection("usuarios").limit(500).get(),
  ]);
  const usersByUid = new Map(userSnapshot.docs.map((document) => [document.id, document.data()]));
  const tecnicos = technicianSnapshot.docs
    .filter((document) => {
      const technician = document.data();
      const user = usersByUid.get(document.id);
      return !technician.deletedAt
        && technician.ativo !== false
        && (!user || (!user.deletedAt && user.ativo !== false && (!user.role || user.role === "tecnico")));
    })
    .map((document) => {
      const technician = document.data();
      const user = usersByUid.get(document.id) ?? {};
      return {
        uid: document.id,
        nome: typeof user.nome === "string" ? user.nome : document.id,
        email: typeof user.email === "string" ? user.email : "",
        whatsapp: typeof technician.whatsapp === "string" ? technician.whatsapp : "",
        cidadesAtendidas: Array.isArray(technician.cidadesAtendidas) ? technician.cidadesAtendidas : [],
        especialidades: Array.isArray(technician.especialidades) ? technician.especialidades : [],
        ativo: technician.ativo !== false,
      };
    });
  const clientes = clientSnapshot.docs
    .filter((document) => !document.data().deletedAt && document.data().ativo !== false)
    .map((document) => ({ id: document.id, razaoSocial: document.data().razaoSocial ?? document.id }));
  const unidades = unitSnapshot.docs
    .filter((document) => !document.data().deletedAt && document.data().ativo !== false)
    .map((document) => {
      const unit = document.data();
      return {
        id: document.id,
        clienteId: unit.clienteId,
        nome: unit.nome,
        cidade: typeof unit.endereco?.cidade === "string" ? unit.endereco.cidade : "",
        tecnicoUids: Array.isArray(unit.tecnicoUids) ? unit.tecnicoUids : [],
      };
    });
  return { clientes, unidades, tecnicos };
});

export const assignTechniciansToUnit = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  requireStaff(auth.token.role);
  const parsed = assignTechniciansSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Atribuição de técnicos inválida.", parsed.error.flatten());

  const { unidadeId, tecnicoUids } = parsed.data;
  const unitRef = firestore.collection("unidades").doc(unidadeId);
  const unitSnapshot = await unitRef.get();
  if (!unitSnapshot.exists || unitSnapshot.data()?.deletedAt || unitSnapshot.data()?.ativo === false) {
    throw new HttpsError("not-found", "Unidade ativa não encontrada.");
  }
  const city = typeof unitSnapshot.data()?.endereco?.cidade === "string" ? unitSnapshot.data()!.endereco.cidade : "";
  if (!city) throw new HttpsError("failed-precondition", "Cadastre a cidade da unidade antes de atribuir técnicos.");

  for (const uid of tecnicoUids) {
    const [technicianSnapshot, user, userProfile] = await Promise.all([
      firestore.collection("tecnicos").doc(uid).get(),
      getAuth().getUser(uid).catch(() => null),
      firestore.collection("usuarios").doc(uid).get(),
    ]);
    const technician = technicianSnapshot.data();
    if (!technicianSnapshot.exists || !technician || technician.deletedAt || technician.ativo === false
      || user?.disabled || user?.customClaims?.role !== "tecnico"
      || userProfile.data()?.deletedAt || userProfile.data()?.ativo === false) {
      throw new HttpsError("failed-precondition", "A lista inclui uma conta que não está cadastrada como técnico ativo.");
    }
    const cities = Array.isArray(technician.cidadesAtendidas) ? technician.cidadesAtendidas.filter((value): value is string => typeof value === "string") : [];
    if (!cities.some((attendedCity) => normalizeCity(attendedCity) === normalizeCity(city))) {
      throw new HttpsError("failed-precondition", `O técnico selecionado não atende a cidade ${city}.`);
    }
  }

  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(unitRef);
    if (!current.exists || current.data()?.deletedAt) throw new HttpsError("not-found", "Unidade não encontrada.");
    const before = Array.isArray(current.data()?.tecnicoUids) ? current.data()?.tecnicoUids : [];
    const now = FieldValue.serverTimestamp();
    transaction.set(unitRef, { tecnicoUids, updatedAt: now }, { merge: true });
    transaction.set(auditRef, {
      atorUid: auth.uid,
      acao: "unidades.tecnicos_atribuidos",
      alvo: { colecao: "unidades", id: unidadeId },
      antes: { tecnicoUids: before },
      depois: { tecnicoUids },
      criadoEm: now,
    });
  });
  return { ok: true, tecnicoUids };
});

export const listCatalog = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  const role = auth.token.role;
  const parsed = listInputSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Cadastro solicitado inválido.");
  const { entity } = parsed.data;

  if (role === "administrador" || role === "analista") {
    return { items: await readStaffCatalog(entity) };
  }

  const clienteId = typeof auth.token.clienteId === "string" ? auth.token.clienteId : null;
  if (role === "cliente" && clienteId) {
    if (entity === "clientes") {
      const client = await firestore.collection("clientes").doc(clienteId).get();
      return { items: client.exists && !client.data()?.deletedAt ? [{ id: client.id, ...serialize(client.data()) as RecordMap }] : [] };
    }
    if (!["unidades", "ativos", "planosPreventivos"].includes(entity)) {
      throw new HttpsError("permission-denied", "Este perfil não pode listar este cadastro.");
    }
    const snapshot = await firestore.collection(entity)
      .where("clienteId", "==", clienteId)
      .limit(250)
      .get();
    return {
      items: snapshot.docs
        .filter((document) => !document.data().deletedAt)
        .map((document) => ({ id: document.id, ...serialize(document.data()) as RecordMap })),
    };
  }

  if (role === "tecnico" && entity === "tecnicos") {
    const technician = await firestore.collection("tecnicos").doc(auth.uid).get();
    return { items: technician.exists && !technician.data()?.deletedAt ? [{ id: technician.id, ...serialize(technician.data()) as RecordMap }] : [] };
  }

  if (role === "tecnico" && (entity === "unidades" || entity === "ativos")) {
    const snapshot = await firestore.collection(entity)
      .where("tecnicoUids", "array-contains", auth.uid)
      .limit(250)
      .get();
    return {
      items: snapshot.docs
        .filter((document) => !document.data().deletedAt)
        .map((document) => ({ id: document.id, ...serialize(document.data()) as RecordMap })),
    };
  }

  if (role === "tecnico" && entity === "planosPreventivos") {
    const [unitsSnapshot, plansSnapshot] = await Promise.all([
      firestore.collection("unidades").where("tecnicoUids", "array-contains", auth.uid).limit(250).get(),
      firestore.collection(entity).limit(500).get(),
    ]);
    const unitsById = new Map(unitsSnapshot.docs
      .filter((document) => !document.data().deletedAt && document.data().ativo !== false)
      .map((document) => [document.id, document.data()]));
    const eligiblePlans = plansSnapshot.docs.filter((document) => {
      const plan = document.data();
      return !plan.deletedAt && plan.ativo !== false
        && (plan.tecnicoId === auth.uid || unitsById.has(String(plan.unidadeId ?? "")));
    });
    const assetRefs = eligiblePlans.flatMap((document) => typeof document.data().ativoId === "string" && document.data().ativoId
      ? [firestore.collection("ativos").doc(document.data().ativoId)]
      : []);
    const assets = assetRefs.length ? await firestore.getAll(...assetRefs) : [];
    const assetsById = new Map(assets.map((asset) => [asset.id, asset.data()]));
    const runRefs = eligiblePlans.map((document) => {
      const plan = document.data() as RecordMap;
      return firestore.collection("execucoesPreventivas").doc(preventiveExecutionId(document.id, preventiveDueDate(plan)));
    });
    const runs = runRefs.length ? await firestore.getAll(...runRefs) : [];
    return {
      items: eligiblePlans.map((document, index) => {
        const plan = document.data();
        const unit = unitsById.get(String(plan.unidadeId ?? "")) ?? {};
        const run = runs[index];
        return {
          id: document.id,
          ...serialize(plan) as RecordMap,
          checklist: normalizePreventiveChecklist(plan.checklist),
          unidadeNome: unit.nome ?? "",
          ativoIdentificacao: typeof plan.ativoId === "string" ? assetsById.get(plan.ativoId)?.identificacao ?? "" : "",
          execucaoId: runRefs[index].id,
          execucaoTopicos: run?.exists ? serialize(run.data()?.topicos) : {},
        };
      }),
    };
  }

  throw new HttpsError("permission-denied", "Este perfil não pode listar este cadastro.");
});

async function getTechnicianExecution(uid: string, planId: string, executionId: string, topicId: string) {
  const { plan, checklist } = await assertTechnicianPlanAccess(uid, planId);
  const dueDate = preventiveDueDate(plan);
  const expectedExecutionId = preventiveExecutionId(planId, dueDate);
  if (executionId !== expectedExecutionId) throw new HttpsError("invalid-argument", "Execução preventiva inválida.");
  const reference = firestore.collection("execucoesPreventivas").doc(expectedExecutionId);
  const snapshot = await reference.get();
  if (!snapshot.exists || snapshot.data()?.planoId !== planId) {
    throw new HttpsError("not-found", "A execução preventiva ainda não foi preparada.");
  }
  const execution = snapshot.data() as RecordMap;
  const assignedUids = Array.isArray(execution.tecnicoUids) ? execution.tecnicoUids : [];
  if (!assignedUids.includes(uid)) throw new HttpsError("permission-denied", "Esta execução não está atribuída ao seu perfil técnico.");
  const topic = checklist.find((entry) => entry.id === topicId);
  if (!topic) throw new HttpsError("not-found", "Tópico não encontrado no plano preventivo.");
  return {
    plan,
    checklist,
    topic,
    reference,
    planReference: firestore.collection("planosPreventivos").doc(planId),
    execution,
  };
}

export const preparePreventivePhoto = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") throw new HttpsError("permission-denied", "Somente técnicos podem iniciar checklists preventivos.");
  const parsed = preparePreventivePhotoSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Dados da foto preventiva inválidos.", parsed.error.flatten());
  const { planoId, topicoId, etapa, mimeType } = parsed.data;
  const { plan, unit, checklist } = await assertTechnicianPlanAccess(auth.uid, planoId);
  const topic = checklist.find((entry) => entry.id === topicoId);
  if (!topic) throw new HttpsError("not-found", "Tópico não encontrado no plano preventivo.");

  const dueDate = preventiveDueDate(plan);
  const executionId = preventiveExecutionId(planoId, dueDate);
  const executionRef = firestore.collection("execucoesPreventivas").doc(executionId);
  const auditRef = firestore.collection("auditoria").doc();
  const technicianUids = [...new Set([
    ...(Array.isArray(unit.tecnicoUids) ? unit.tecnicoUids.filter((uid): uid is string => typeof uid === "string") : []),
    ...(typeof plan.tecnicoId === "string" ? [plan.tecnicoId] : []),
  ])];
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
  const objectPath = `clientes/${String(plan.clienteId)}/planosPreventivos/${planoId}/execucoes/${executionId}/topicos/${topicoId}/${etapa}/${auth.uid}_${randomUUID()}.${extension}`;

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(executionRef);
    const currentData = snapshot.data() as RecordMap | undefined;
    const currentTopic = currentData ? executionTopic(currentData, topicoId) : null;
    if (etapa === "antes" && currentTopic && currentTopic.status !== "aguardando_foto_antes") {
      throw new HttpsError("failed-precondition", "A foto inicial só pode ser enviada antes de iniciar o tópico.");
    }
    if (etapa === "depois") {
      if (!currentTopic || currentTopic.status !== "em_andamento" || currentTopic.iniciadoPor !== auth.uid) {
        throw new HttpsError("failed-precondition", "Inicie este tópico com a foto inicial antes de enviar a foto final.");
      }
      const completed = currentTopic.atividadesConcluidas ?? {};
      if (!topic.atividades.every((activity) => completed[activity.id] === true)) {
        throw new HttpsError("failed-precondition", "Marque todas as atividades antes de preparar a foto final.");
      }
    }
    const nextTopic: PreventiveTopicState = {
      status: currentTopic?.status ?? "aguardando_foto_antes",
      atividadesConcluidas: currentTopic?.atividadesConcluidas ?? {},
      observacao: currentTopic?.observacao ?? "",
      ...(currentTopic ?? {}),
      ...(etapa === "antes" ? { fotoAntesPendentePath: objectPath } : { fotoDepoisPendentePath: objectPath }),
      atualizadoEm: FieldValue.serverTimestamp(),
    };
    const nextTopics = {
      ...(currentData?.topicos && typeof currentData.topicos === "object" ? currentData.topicos as Record<string, unknown> : {}),
      [topicoId]: nextTopic,
    };
    const now = FieldValue.serverTimestamp();
    transaction.set(executionRef, {
      planoId,
      clienteId: plan.clienteId,
      unidadeId: plan.unidadeId,
      dataProgramada: dueDate,
      tecnicoUids: technicianUids,
      topicos: nextTopics,
      ...(snapshot.exists ? {} : { criadoEm: now }),
      atualizadoEm: now,
    }, { merge: true });
    transaction.set(auditRef, auditExecutionChange(
      auth.uid,
      executionId,
      topicoId,
      `preventivas.foto_${etapa}_preparada`,
      currentTopic,
      { ...nextTopic, fotoPathPendente: objectPath },
    ));
  });
  return { executionId, objectPath };
});

export const startPreventiveTopic = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") throw new HttpsError("permission-denied", "Somente técnicos podem iniciar checklists preventivos.");
  const parsed = preventiveTopicActionSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Dados de início do tópico inválidos.", parsed.error.flatten());
  const { planoId, execucaoId, topicoId } = parsed.data;
  const context = await getTechnicianExecution(auth.uid, planoId, execucaoId, topicoId);
  const before = executionTopic(context.execution, topicoId);
  const beforePath = before?.fotoAntesPendentePath;
  if (!beforePath || before?.status !== "aguardando_foto_antes") {
    throw new HttpsError("failed-precondition", "Envie a foto inicial antes de iniciar este tópico.");
  }
  const [exists] = await getStorage().bucket().file(beforePath).exists();
  if (!exists) throw new HttpsError("failed-precondition", "A foto inicial ainda não foi enviada.");

  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(context.reference);
    const currentData = current.data() as RecordMap | undefined;
    const currentTopic = currentData ? executionTopic(currentData, topicoId) : null;
    if (!currentTopic || currentTopic.status !== "aguardando_foto_antes" || currentTopic.fotoAntesPendentePath !== beforePath) {
      throw new HttpsError("failed-precondition", "O tópico mudou durante o envio. Atualize a tela e tente novamente.");
    }
    const nextTopic: PreventiveTopicState = {
      ...currentTopic,
      status: "em_andamento",
      iniciadoPor: auth.uid,
      fotoAntesPath: beforePath,
      iniciadoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    };
    transaction.set(context.reference, { topicos: { [topicoId]: nextTopic }, atualizadoEm: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(auditRef, auditExecutionChange(auth.uid, execucaoId, topicoId, "preventivas.topico_iniciado", currentTopic, nextTopic));
  });
  return { ok: true };
});

export const updatePreventiveActivity = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") throw new HttpsError("permission-denied", "Somente técnicos podem atualizar checklists preventivos.");
  const parsed = preventiveActivitySchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Dados da atividade inválidos.", parsed.error.flatten());
  const { planoId, execucaoId, topicoId, atividadeId, concluida } = parsed.data;
  const context = await getTechnicianExecution(auth.uid, planoId, execucaoId, topicoId);
  if (!context.topic.atividades.some((activity) => activity.id === atividadeId)) {
    throw new HttpsError("not-found", "Atividade não encontrada neste tópico.");
  }
  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(context.reference);
    const currentData = current.data() as RecordMap | undefined;
    const currentTopic = currentData ? executionTopic(currentData, topicoId) : null;
    if (!currentTopic || currentTopic.status !== "em_andamento" || currentTopic.iniciadoPor !== auth.uid) {
      throw new HttpsError("failed-precondition", "Somente quem iniciou o tópico pode marcar suas atividades.");
    }
    const nextTopic: PreventiveTopicState = {
      ...currentTopic,
      atividadesConcluidas: { ...currentTopic.atividadesConcluidas, [atividadeId]: concluida },
      atualizadoEm: FieldValue.serverTimestamp(),
    };
    transaction.set(context.reference, { topicos: { [topicoId]: nextTopic }, atualizadoEm: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(auditRef, auditExecutionChange(auth.uid, execucaoId, topicoId, "preventivas.atividade_atualizada", currentTopic, nextTopic));
  });
  return { ok: true };
});

export const savePreventiveObservation = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") throw new HttpsError("permission-denied", "Somente técnicos podem registrar observações preventivas.");
  const parsed = preventiveObservationSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Observação inválida.", parsed.error.flatten());
  const { planoId, execucaoId, topicoId, observacao } = parsed.data;
  const context = await getTechnicianExecution(auth.uid, planoId, execucaoId, topicoId);
  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(context.reference);
    const currentData = current.data() as RecordMap | undefined;
    const currentTopic = currentData ? executionTopic(currentData, topicoId) : null;
    if (!currentTopic || currentTopic.status !== "em_andamento" || currentTopic.iniciadoPor !== auth.uid) {
      throw new HttpsError("failed-precondition", "Somente quem iniciou o tópico pode alterar a observação.");
    }
    const nextTopic = { ...currentTopic, observacao, atualizadoEm: FieldValue.serverTimestamp() };
    transaction.set(context.reference, { topicos: { [topicoId]: nextTopic }, atualizadoEm: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(auditRef, auditExecutionChange(auth.uid, execucaoId, topicoId, "preventivas.observacao_atualizada", currentTopic, nextTopic));
  });
  return { ok: true };
});

export const completePreventiveTopic = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") throw new HttpsError("permission-denied", "Somente técnicos podem concluir checklists preventivos.");
  const parsed = preventiveTopicActionSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Dados de conclusão do tópico inválidos.", parsed.error.flatten());
  const { planoId, execucaoId, topicoId } = parsed.data;
  const context = await getTechnicianExecution(auth.uid, planoId, execucaoId, topicoId);
  const before = executionTopic(context.execution, topicoId);
  if (!before || before.status !== "em_andamento" || before.iniciadoPor !== auth.uid) {
    throw new HttpsError("failed-precondition", "Inicie o tópico antes de concluí-lo.");
  }
  if (!context.topic.atividades.every((activity) => before.atividadesConcluidas[activity.id] === true)) {
    throw new HttpsError("failed-precondition", "Marque todas as atividades antes de concluir o tópico.");
  }
  const afterPath = before.fotoDepoisPendentePath;
  if (!afterPath) throw new HttpsError("failed-precondition", "Envie a foto final antes de concluir o tópico.");
  const [exists] = await getStorage().bucket().file(afterPath).exists();
  if (!exists) throw new HttpsError("failed-precondition", "A foto final ainda não foi enviada.");

  const auditRef = firestore.collection("auditoria").doc();
  const planAuditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(context.reference);
    const currentPlanSnapshot = await transaction.get(context.planReference);
    if (!currentPlanSnapshot.exists || currentPlanSnapshot.data()?.deletedAt) {
      throw new HttpsError("not-found", "Plano preventivo não encontrado durante a conclusão.");
    }
    const currentData = current.data() as RecordMap | undefined;
    const currentTopic = currentData ? executionTopic(currentData, topicoId) : null;
    if (!currentTopic || currentTopic.status !== "em_andamento" || currentTopic.iniciadoPor !== auth.uid
      || currentTopic.fotoDepoisPendentePath !== afterPath
      || !context.topic.atividades.every((activity) => currentTopic.atividadesConcluidas[activity.id] === true)) {
      throw new HttpsError("failed-precondition", "O tópico mudou durante a conclusão. Atualize a tela e tente novamente.");
    }
    const nextTopic: PreventiveTopicState = {
      ...currentTopic,
      status: "concluido",
      fotoDepoisPath: afterPath,
      concluidoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    };
    const currentTopics = currentData?.topicos && typeof currentData.topicos === "object"
      ? currentData.topicos as Record<string, unknown>
      : {};
    const allTopicsCompleted = context.checklist.every((topic) => topic.id === topicoId
      ? nextTopic.status === "concluido"
      : (executionTopic({ topicos: currentTopics }, topic.id)?.status === "concluido"));
    const currentPlan = currentPlanSnapshot.data() as RecordMap;
    const currentDueDate = preventiveDueDate(currentPlan);
    if (currentDueDate !== currentData?.dataProgramada) {
      throw new HttpsError("failed-precondition", "A data do plano mudou durante a execução. Atualize a tela.");
    }
    transaction.set(context.reference, { topicos: { [topicoId]: nextTopic }, atualizadoEm: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(auditRef, auditExecutionChange(auth.uid, execucaoId, topicoId, "preventivas.topico_concluido", currentTopic, nextTopic));
    if (allTopicsCompleted) {
      const nextDueDate = nextPreventiveDueDate(currentDueDate, currentPlan.periodicidade);
      transaction.set(context.planReference, { proximaExecucao: nextDueDate, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(planAuditRef, {
        atorUid: auth.uid,
        acao: "planosPreventivos.proxima_execucao_atualizada",
        alvo: { colecao: "planosPreventivos", id: planoId },
        antes: { proximaExecucao: currentDueDate },
        depois: { proximaExecucao: nextDueDate, execucaoId },
        criadoEm: FieldValue.serverTimestamp(),
      });
    }
  });
  return { ok: true };
});

export const getPreventivePhotoUrl = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") throw new HttpsError("permission-denied", "Somente técnicos atribuídos podem acessar as fotos preventivas.");
  const parsed = preventivePhotoUrlSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Referência de foto inválida.", parsed.error.flatten());
  const { planoId, execucaoId, topicoId, etapa } = parsed.data;
  const context = await getTechnicianExecution(auth.uid, planoId, execucaoId, topicoId);
  const topicState = executionTopic(context.execution, topicoId);
  const objectPath = etapa === "antes" ? topicState?.fotoAntesPath : topicState?.fotoDepoisPath;
  if (!objectPath) throw new HttpsError("not-found", "A foto solicitada ainda não foi registrada.");
  const [url] = await getStorage().bucket().file(objectPath).getSignedUrl({ action: "read", expires: Date.now() + 5 * 60 * 1000 });
  return { url };
});

export const updateOwnProfile = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "tecnico") {
    throw new HttpsError("permission-denied", "Somente técnicos podem editar o próprio perfil por este fluxo.");
  }
  const parsed = ownProfileSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Dados do perfil inválidos.", parsed.error.flatten());

  const userRef = firestore.collection("usuarios").doc(auth.uid);
  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(userRef);
    if (!current.exists || current.data()?.deletedAt) {
      throw new HttpsError("not-found", "Perfil não encontrado.");
    }
    const before = current.data();
    const now = FieldValue.serverTimestamp();
    const after = { nome: parsed.data.nome, ...(parsed.data.telefone ? { telefone: parsed.data.telefone } : {}), updatedAt: now };
    transaction.set(userRef, after, { merge: true });
    transaction.set(auditRef, {
      atorUid: auth.uid,
      acao: "usuarios.perfil_proprio_editado",
      alvo: { colecao: "usuarios", id: auth.uid },
      antes: { nome: before?.nome ?? null, telefone: before?.telefone ?? null },
      depois: { nome: parsed.data.nome, telefone: parsed.data.telefone ?? null },
      criadoEm: now,
    });
  });
  await getAuth().updateUser(auth.uid, { displayName: parsed.data.nome });
  return { ok: true };
});

export const saveCatalogRecord = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  requireStaff(auth.token.role);
  const parsed = saveInputSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Dados do cadastro inválidos.", parsed.error.flatten());

  const { entity, id: requestedId, record: rawRecord } = parsed.data;
  const result = recordSchemas[entity].safeParse(rawRecord);
  if (!result.success) throw new HttpsError("invalid-argument", "Revise os campos do cadastro.", result.error.flatten());
  const record = result.data as RecordMap;
  const id = requestedId ?? (entity === "tecnicos" ? String(record.usuarioUid) : firestore.collection(entity).doc().id);
  await assertRelatedRecords(entity, record, id);

  const documentRef = firestore.collection(entity).doc(id);
  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(documentRef);
    if (current.data()?.deletedAt) {
      throw new HttpsError("failed-precondition", "Este cadastro foi excluído logicamente e não pode ser editado.");
    }
    const now = FieldValue.serverTimestamp();
    const updatedRecord = {
      ...record,
      ...(entity === "clientes" ? { clienteId: id } : {}),
      ...(current.exists ? {} : { createdAt: now }),
      updatedAt: now,
    };
    transaction.set(documentRef, updatedRecord, { merge: true });
    transaction.set(auditRef, {
      atorUid: auth.uid,
      acao: current.exists ? `${entity}.editado` : `${entity}.criado`,
      alvo: { colecao: entity, id },
      ...(current.exists ? { antes: serialize(current.data()) } : {}),
      depois: serialize(updatedRecord),
      criadoEm: now,
    });
  });
  return { id };
});

export const assignExistingUser = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  const actorRole = requireStaff(auth.token.role);
  const parsed = assignUserSchema.safeParse(request.data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "formulário"}: ${issue.message}`)
      .join("; ");
    throw new HttpsError("invalid-argument", `Dados do usuário inválidos: ${issues}.`, parsed.error.flatten());
  }
  const profile = parsed.data;

  if (actorRole === "analista" && profile.role === "administrador") {
    throw new HttpsError("permission-denied", "Analistas não podem criar usuários administradores.");
  }
  if ((profile.role === "cliente") !== Boolean(profile.clienteId)) {
    throw new HttpsError("invalid-argument", "Informe clienteId somente para o perfil cliente.");
  }
  if (profile.clienteId) await assertActiveClient(profile.clienteId);

  let user;
  let created = false;
  let passwordResetLink: string | null = null;
  try {
    user = await getAuth().getUserByEmail(profile.email.toLowerCase());
  } catch (error) {
    const errorCode = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (errorCode !== "auth/user-not-found") {
      throw new HttpsError("internal", "Não foi possível consultar a conta no Firebase Authentication.");
    }
    try {
      user = await getAuth().createUser({
        email: profile.email.toLowerCase(),
        displayName: profile.nome,
      });
      created = true;
      passwordResetLink = await getAuth().generatePasswordResetLink(profile.email.toLowerCase());
    } catch {
      if (user?.uid && created) await getAuth().deleteUser(user.uid).catch(() => undefined);
      throw new HttpsError("internal", "Não foi possível criar a conta ou gerar o link de definição de senha.");
    }
  }
  const profileRef = firestore.collection("usuarios").doc(user.uid);
  const existingProfileSnapshot = await profileRef.get();
  const existingProfile = existingProfileSnapshot.data();
  const restored = Boolean(existingProfile?.deletedAt);
  if (user.disabled && !restored) {
    throw new HttpsError("failed-precondition", "A conta está desativada no Firebase Authentication e não foi excluída pelo sistema. Um administrador deve verificar a conta antes de vinculá-la.");
  }
  if (restored && actorRole !== "administrador") {
    throw new HttpsError("permission-denied", "Somente administradores podem restaurar usuários excluídos logicamente.");
  }

  const before = {
    role: typeof user.customClaims?.role === "string" ? user.customClaims.role : null,
    clienteId: typeof user.customClaims?.clienteId === "string" ? user.customClaims.clienteId : null,
    authDisabled: user.disabled,
    deletedAt: existingProfile?.deletedAt ? serialize(existingProfile.deletedAt) : null,
    deletedBy: typeof existingProfile?.deletedBy === "string" ? existingProfile.deletedBy : null,
  };
  const claims: Record<string, unknown> = { ...(user.customClaims ?? {}), role: profile.role };
  if (profile.role === "cliente" && profile.clienteId) claims.clienteId = profile.clienteId;
  else delete claims.clienteId;

  await getAuth().setCustomUserClaims(user.uid, claims);
  if (restored && user.disabled) await getAuth().updateUser(user.uid, { disabled: false });
  if (restored) {
    try {
      passwordResetLink = await getAuth().generatePasswordResetLink(profile.email.toLowerCase());
    } catch {
      passwordResetLink = null;
    }
  }
  const technicianRef = firestore.collection("tecnicos").doc(user.uid);
  const cityOptionsRef = firestore.collection("configuracoes").doc("cidadesTecnicos");
  const auditRef = firestore.collection("auditoria").doc();
  const technicianCities = profile.role === "tecnico"
    ? [...new Map([...(profile.cidadesAtendidas ?? []), ...(profile.outraCidade ? [profile.outraCidade] : [])]
      .map((city) => [normalizeCity(city), city.trim()] as const)).values()]
    : [];
  const previousTechnician = await technicianRef.get();
  const batch = firestore.batch();
  batch.set(profileRef, {
    uid: user.uid,
    nome: profile.nome,
    email: user.email ?? profile.email.toLowerCase(),
    ...(profile.telefone ? { telefone: profile.telefone } : {}),
    role: profile.role,
    ...(profile.role === "cliente" && profile.clienteId ? { clienteId: profile.clienteId } : {}),
    ativo: true,
    deletedAt: FieldValue.delete(),
    deletedBy: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (profile.role === "tecnico") {
    batch.set(technicianRef, {
      usuarioUid: user.uid,
      whatsapp: profile.telefone,
      cidadesAtendidas: technicianCities,
      especialidades: profile.especialidades,
      ativo: true,
      deletedAt: FieldValue.delete(),
      deletedBy: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const newCities = technicianCities.filter((city) => !defaultTechnicianCities.some((defaultCity) => normalizeCity(defaultCity) === normalizeCity(city)));
    if (newCities.length) {
      batch.set(cityOptionsRef, {
        customCidades: FieldValue.arrayUnion(...newCities),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  } else if (previousTechnician.exists) {
    batch.set(technicianRef, { ativo: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  batch.set(auditRef, {
    atorUid: auth.uid,
    acao: created ? "usuarios.criado" : restored ? "usuarios.restaurado" : "usuarios.perfil_atribuido",
    alvo: { colecao: "usuarios", id: user.uid },
    antes: before,
    depois: {
      role: profile.role,
      ativo: true,
      authDisabled: false,
      restaurado: restored,
      ...(profile.clienteId ? { clienteId: profile.clienteId } : {}),
      ...(profile.role === "tecnico" ? { cidadesAtendidas: technicianCities, especialidades: profile.especialidades } : {}),
    },
    criadoEm: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { uid: user.uid, created, restored, passwordResetLink };
});

export const softDeleteCatalogRecord = onCall(callableOptions, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.role !== "administrador") {
    throw new HttpsError("permission-denied", "Somente administradores podem excluir cadastros logicamente.");
  }
  const parsed = deleteInputSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Cadastro a excluir inválido.");
  const { entity, id } = parsed.data as { entity: DeletableEntity; id: string };
  const documentRef = firestore.collection(entity).doc(id);
  const technicianRef = entity === "usuarios" ? firestore.collection("tecnicos").doc(id) : null;
  const auditRef = firestore.collection("auditoria").doc();

  if (entity === "usuarios") {
    try {
      const user = await getAuth().getUser(id);
      await getAuth().updateUser(id, { disabled: true });
      await getAuth().revokeRefreshTokens(id);
      const claims: Record<string, unknown> = { ...(user.customClaims ?? {}) };
      delete claims.role;
      delete claims.clienteId;
      await getAuth().setCustomUserClaims(id, claims);
    } catch {
      throw new HttpsError("not-found", "Usuário de autenticação não encontrado.");
    }
  }

  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(documentRef);
    if (!current.exists) throw new HttpsError("not-found", "Cadastro não encontrado.");
    if (current.data()?.deletedAt) return;
    const technician = technicianRef ? await transaction.get(technicianRef) : null;
    const now = FieldValue.serverTimestamp();
    const after = { deletedAt: now, deletedBy: auth.uid, ativo: false, updatedAt: now };
    transaction.set(documentRef, after, { merge: true });
    if (technician?.exists) transaction.set(technicianRef!, { ativo: false, updatedAt: now }, { merge: true });
    transaction.set(auditRef, {
      atorUid: auth.uid,
      acao: `${entity}.excluido_logicamente`,
      alvo: { colecao: entity, id },
      antes: serialize(current.data()),
      ...(technician?.exists ? { relacionados: { tecnico: serialize(technician.data()) } } : {}),
      depois: { ...after, ...(technician?.exists ? { tecnico: { ativo: false } } : {}) },
      criadoEm: now,
    });
  });
  return { ok: true };
});
