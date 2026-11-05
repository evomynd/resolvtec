import { z } from "zod";

export const catalogEntities = ["clientes", "unidades", "ativos", "tecnicos", "planosPreventivos", "usuarios"] as const;
export type CatalogEntity = (typeof catalogEntities)[number];
export type CatalogDraft = Record<string, string>;

export const catalogDraftSchema = z.record(z.string(), z.string());

const centsSchema = z.string().trim().regex(/^\d+(?:[,.]\d{1,2})?$/, "Informe um valor em reais, por exemplo 1250,00.")
  .transform((value) => Math.round(Number(value.replace(",", ".")) * 100));
const minutesSchema = z.string().trim().regex(/^\d+$/, "Informe o tempo em minutos.").transform(Number);
const cnpjSchema = z.string().transform((value) => value.replace(/\D/g, "")).pipe(z.string().regex(/^\d{14}$/, "CNPJ deve ter 14 dígitos."));
const e164Schema = z.string().regex(/^\+\d{10,15}$/, "Use o formato internacional, por exemplo +5511999999999.");
const optionalPhoneSchema = z.string().trim().transform((value) => value || undefined).pipe(e164Schema.optional());
const csvSchema = z.string().transform((value) => value.split(/[\n,;]/).map((part) => part.trim()).filter(Boolean));
const optionalNumberSchema = z.string().trim().transform((value) => value === "" ? undefined : Number(value));
const checklistIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "Identificador de checklist inválido.");
const checklistTopicSchema = z.object({
  id: checklistIdSchema,
  titulo: z.string().trim().min(1, "Informe o nome do tópico.").max(120),
  atividades: z.array(z.object({
    id: checklistIdSchema,
    descricao: z.string().trim().min(1, "Informe a atividade.").max(300),
  })).min(1, "Adicione ao menos uma atividade ao tópico.").max(100),
});
const checklistTopicsListSchema = z.array(checklistTopicSchema).min(1, "Adicione ao menos um tópico.").max(30).superRefine((topics, context) => {
  const topicIds = new Set<string>();
  topics.forEach((topic, topicIndex) => {
    if (topicIds.has(topic.id)) context.addIssue({ code: "custom", path: [topicIndex, "id"], message: "Cada tópico precisa de um identificador único." });
    topicIds.add(topic.id);
    const activityIds = new Set<string>();
    topic.atividades.forEach((activity, activityIndex) => {
      if (activityIds.has(activity.id)) context.addIssue({ code: "custom", path: [topicIndex, "atividades", activityIndex, "id"], message: "Cada atividade do tópico precisa de um identificador único." });
      activityIds.add(activity.id);
    });
  });
});
const checklistTopicsSchema = z.string().transform((value, context) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    const activities = value.split(/[\n;]/).map((description, index) => ({
      id: `atividade-${index + 1}`,
      descricao: description.trim(),
    })).filter((activity) => activity.descricao);
    parsed = [{ id: "topico-geral", titulo: "Checklist geral", atividades: activities }];
  }
  const result = checklistTopicsListSchema.safeParse(parsed);
  if (!result.success) {
    context.addIssue({ code: "custom", message: result.error.issues[0]?.message ?? "Revise os tópicos e atividades." });
    return z.NEVER;
  }
  return result.data;
});

export const clientFormSchema = z.object({
  razaoSocial: z.string().trim().min(2, "Informe a razão social."),
  cnpj: cnpjSchema,
  segmento: z.string().trim().min(1, "Informe o segmento."),
  porteContrato: z.enum(["A", "B", "C"]),
  slaRespostaMinutos: minutesSchema,
  slaSolucaoMinutos: minutesSchema,
  valorHoraTecnica: centsSchema,
  valorMensal: centsSchema,
  contatoNome: z.string().trim().optional(),
  contatoEmail: z.string().trim().transform((value) => value || undefined).pipe(z.email().optional()),
  contatoTelefone: optionalPhoneSchema,
}).superRefine((value, context) => {
  if ((value.contatoEmail || value.contatoTelefone) && !value.contatoNome) {
    context.addIssue({ code: "custom", path: ["contatoNome"], message: "Informe o nome do contato." });
  }
}).transform((value) => ({
  razaoSocial: value.razaoSocial,
  cnpj: value.cnpj,
  segmento: value.segmento,
  porteContrato: value.porteContrato,
  sla: { respostaMinutos: value.slaRespostaMinutos, solucaoMinutos: value.slaSolucaoMinutos },
  valorHoraTecnicaCentavos: value.valorHoraTecnica,
  valorMensalCentavos: value.valorMensal,
  contatos: value.contatoNome ? [{ nome: value.contatoNome, email: value.contatoEmail ?? "", telefone: value.contatoTelefone ?? "" }] : [],
  ativo: true,
}));

export const unitFormSchema = z.object({
  clienteId: z.string().min(1, "Selecione um cliente."),
  nome: z.string().trim().min(1, "Informe o nome da unidade."),
  logradouro: z.string().trim().min(1, "Informe o logradouro."),
  numero: z.string().trim().min(1, "Informe o número."),
  complemento: z.string().trim(),
  bairro: z.string().trim(),
  cep: z.string().trim().min(8, "Informe o CEP."),
  cidade: z.string().trim().min(1, "Informe a cidade."),
  uf: z.string().trim().transform((value) => value.toUpperCase()).pipe(z.string().length(2, "Use a sigla do estado.")),
  latitude: optionalNumberSchema,
  longitude: optionalNumberSchema,
  responsavelNome: z.string().trim(),
  responsavelEmail: z.string().trim().transform((value) => value || undefined).pipe(z.email().optional()),
  responsavelTelefone: optionalPhoneSchema,
  whatsappAutorizados: csvSchema,
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) {
    context.addIssue({ code: "custom", path: ["latitude"], message: "Informe latitude e longitude juntas." });
  }
  if (value.latitude !== undefined && (value.latitude < -90 || value.latitude > 90)) {
    context.addIssue({ code: "custom", path: ["latitude"], message: "Latitude inválida." });
  }
  if (value.longitude !== undefined && (value.longitude < -180 || value.longitude > 180)) {
    context.addIssue({ code: "custom", path: ["longitude"], message: "Longitude inválida." });
  }
  if ((value.responsavelEmail || value.responsavelTelefone) && !value.responsavelNome) {
    context.addIssue({ code: "custom", path: ["responsavelNome"], message: "Informe o nome do responsável." });
  }
}).transform((value) => ({
  clienteId: value.clienteId,
  nome: value.nome,
  endereco: {
    logradouro: value.logradouro,
    numero: value.numero,
    complemento: value.complemento,
    bairro: value.bairro,
    cep: value.cep,
    cidade: value.cidade,
    uf: value.uf,
  },
  ...(value.latitude !== undefined && value.longitude !== undefined ? { coordenadas: { latitude: value.latitude, longitude: value.longitude } } : {}),
  responsaveis: value.responsavelNome ? [{ nome: value.responsavelNome, email: value.responsavelEmail ?? "", telefone: value.responsavelTelefone ?? "" }] : [],
  whatsappAutorizados: value.whatsappAutorizados.map((phone) => e164Schema.parse(phone)),
  ativo: true,
}));

export const assetFormSchema = z.object({
  clienteId: z.string().min(1, "Selecione um cliente."),
  unidadeId: z.string().min(1, "Selecione uma unidade."),
  sistema: z.enum(["ar-condicionado", "eletrica", "iluminacao-emergencia", "hidraulica", "outro"]),
  tipo: z.string().trim().min(1, "Informe o tipo de ativo."),
  identificacao: z.string().trim().min(1, "Informe a identificação."),
  observacoes: z.string().trim(),
}).transform((value) => ({ ...value, sensoresIds: [], tecnicoUids: [], ativo: true }));

export const technicianFormSchema = z.object({
  usuarioUid: z.string().trim().min(1, "Informe o UID de uma conta já cadastrada."),
  whatsapp: e164Schema,
  cidadesAtendidas: csvSchema.pipe(z.array(z.string().min(1)).min(1, "Informe ao menos uma cidade.")),
  especialidades: csvSchema.pipe(z.array(z.enum(["ar-condicionado", "eletrica", "hidraulica", "civil"])).min(1, "Informe ao menos uma especialidade.")),
}).transform((value) => ({ ...value, ativo: true }));

export const preventivePlanFormSchema = z.object({
  clienteId: z.string().min(1, "Selecione um cliente."),
  unidadeId: z.string().min(1, "Selecione uma unidade."),
  ativoId: z.string().trim(),
  sistema: z.enum(["ar-condicionado", "eletrica", "iluminacao-emergencia", "hidraulica", "outro"]),
  periodicidade: z.enum(["semanal", "quinzenal", "mensal", "bimestral", "trimestral", "semestral", "anual"]),
  checklist: checklistTopicsSchema,
  tecnicoId: z.string().trim(),
  equipeId: z.string().trim(),
  proximaExecucao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe a próxima execução."),
}).transform((value) => ({
  clienteId: value.clienteId,
  unidadeId: value.unidadeId,
  sistema: value.sistema,
  periodicidade: value.periodicidade,
  checklist: value.checklist,
  proximaExecucao: value.proximaExecucao,
  ...(value.ativoId ? { ativoId: value.ativoId } : {}),
  ...(value.tecnicoId ? { tecnicoId: value.tecnicoId } : {}),
  ...(value.equipeId ? { equipeId: value.equipeId } : {}),
  ativo: true,
}));

export const existingUserFormSchema = z.object({
  nome: z.string().trim().min(1, "Informe o nome."),
  email: z.email("Informe um e-mail válido."),
  telefone: optionalPhoneSchema,
  role: z.enum(["administrador", "analista", "tecnico", "cliente"]),
  clienteId: z.string().trim(),
  cidadesAtendidas: csvSchema,
  especialidades: csvSchema.pipe(z.array(z.enum(["ar-condicionado", "eletrica", "hidraulica", "civil"]))),
  outraCidadeAtiva: z.string().optional(),
  outraCidade: z.string().trim(),
}).superRefine((value, context) => {
  if (value.role === "cliente" && !value.clienteId) {
    context.addIssue({ code: "custom", path: ["clienteId"], message: "Selecione o cliente vinculado." });
  }
  if (value.role !== "cliente" && value.clienteId) {
    context.addIssue({ code: "custom", path: ["clienteId"], message: "Vínculo de cliente só se aplica ao perfil cliente." });
  }
  if (value.role === "tecnico") {
    if (!value.telefone) context.addIssue({ code: "custom", path: ["telefone"], message: "WhatsApp do técnico é obrigatório." });
    if (!value.cidadesAtendidas.length && value.outraCidadeAtiva !== "true") context.addIssue({ code: "custom", path: ["cidadesAtendidas"], message: "Selecione ao menos uma cidade." });
    if (value.outraCidadeAtiva === "true" && !value.outraCidade) context.addIssue({ code: "custom", path: ["outraCidade"], message: "Informe o nome da outra cidade." });
    if (!value.especialidades.length) context.addIssue({ code: "custom", path: ["especialidades"], message: "Selecione ao menos uma especialidade." });
  }
}).transform(({ clienteId, telefone, cidadesAtendidas, especialidades, outraCidadeAtiva, outraCidade, ...value }) => ({
  ...value,
  ...(clienteId ? { clienteId } : {}),
  ...(telefone ? { telefone } : {}),
  ...(value.role === "tecnico" ? {
    cidadesAtendidas,
    especialidades,
    ...(outraCidadeAtiva === "true" && outraCidade ? { outraCidade } : {}),
  } : {}),
}));

export const technicianSelfProfileSchema = z.object({
  nome: z.string().trim().min(1, "Informe o nome."),
  telefone: optionalPhoneSchema,
}).transform(({ nome, telefone }) => ({ nome, ...(telefone ? { telefone } : {}) }));

export type ParsedCatalogRecord =
  | z.output<typeof clientFormSchema>
  | z.output<typeof unitFormSchema>
  | z.output<typeof assetFormSchema>
  | z.output<typeof technicianFormSchema>
  | z.output<typeof preventivePlanFormSchema>;
