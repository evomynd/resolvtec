"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Archive, ArrowLeft, Building2, Check, ClipboardList, Copy, FilePlus2, LogOut, Pencil, ShieldCheck, Trash2, UserRound, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PreventiveExecutionPanel } from "@/components/preventive-execution-panel";
import { TechnicianAssignmentPanel } from "@/components/technician-assignment-panel";
import { appRoles, roleLabels, type AppRole } from "@/lib/auth/schema";
import { auth, functions } from "@/lib/firebase/client";
import { brlCurrency } from "@resolvtec/shared";
import {
  assetFormSchema,
  catalogDraftSchema,
  clientFormSchema,
  existingUserFormSchema,
  preventivePlanFormSchema,
  technicianFormSchema,
  technicianSelfProfileSchema,
  unitFormSchema,
  type CatalogDraft,
  type CatalogEntity,
} from "@/lib/catalog/schema";

type CatalogRecord = Record<string, unknown> & { id: string };
type PanelIdentity = { user: User; role: AppRole | null; clienteId: string | null };
type PanelSection = CatalogEntity | "perfil";
type FieldKind = "text" | "email" | "number" | "date" | "select" | "textarea" | "checkboxes" | "checkbox-toggle" | "checklist-topics";
type FieldOption = { value: string; label: string; scopeId?: string };
type FieldDefinition = {
  name: string;
  label: string;
  type?: FieldKind;
  placeholder?: string;
  required?: boolean;
  requiredForRole?: AppRole;
  onlyRole?: AppRole;
  showWhen?: { field: string; value: string };
  step?: string;
  options?: FieldOption[];
};

const staffSections: { id: CatalogEntity; label: string; icon: typeof Building2 }[] = [
  { id: "clientes", label: "Clientes", icon: Building2 },
  { id: "unidades", label: "Unidades", icon: Building2 },
  { id: "ativos", label: "Ativos", icon: Wrench },
  { id: "tecnicos", label: "Técnicos", icon: UserRound },
  { id: "planosPreventivos", label: "Planos preventivos", icon: ClipboardList },
  { id: "usuarios", label: "Usuários", icon: ShieldCheck },
];
const clientSections: { id: CatalogEntity; label: string; icon: typeof Building2 }[] = [
  { id: "clientes", label: "Minha empresa", icon: Building2 },
  { id: "unidades", label: "Unidades", icon: Building2 },
  { id: "ativos", label: "Ativos", icon: Wrench },
  { id: "planosPreventivos", label: "Planos preventivos", icon: ClipboardList },
];
function errorMessage(error: unknown) {
  if (error instanceof FirebaseError) {
    if (error.code === "functions/permission-denied") return "Seu perfil não tem permissão para esta ação.";
    if (error.code === "functions/unauthenticated") return "Sua sessão expirou. Entre novamente.";
    if (error.code === "functions/failed-precondition") return error.message;
  }
  return error instanceof Error ? error.message : "Não foi possível concluir a operação.";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function nestedString(value: unknown, key: string) {
  return asString(asRecord(value)[key]);
}

function toReais(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? (amount / 100).toFixed(2) : "0,00";
}

function commaSeparated(value: unknown) {
  return Array.isArray(value) ? value.map(asString).join(", ") : "";
}

type ChecklistActivity = { id: string; descricao: string };
type ChecklistTopic = { id: string; titulo: string; atividades: ChecklistActivity[] };

function newChecklistId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function createChecklistTopic(): ChecklistTopic {
  return { id: newChecklistId("topico"), titulo: "", atividades: [{ id: newChecklistId("atividade"), descricao: "" }] };
}

function normalizeChecklist(value: unknown): ChecklistTopic[] {
  if (!Array.isArray(value) || value.length === 0) return [createChecklistTopic()];
  if (value.every((item) => typeof item === "string")) {
    return [{
      id: "topico-geral",
      titulo: "Checklist geral",
      atividades: value.map((item, index) => ({ id: `atividade-${index + 1}`, descricao: String(item) })),
    }];
  }
  return value.map((item, index) => {
    const topic = asRecord(item);
    const activities = Array.isArray(topic.atividades) ? topic.atividades : [];
    return {
      id: asString(topic.id) || `topico-${index + 1}`,
      titulo: asString(topic.titulo),
      atividades: activities.map((activity, activityIndex) => {
        const entry = asRecord(activity);
        return {
          id: asString(entry.id) || `topico-${index + 1}-atividade-${activityIndex + 1}`,
          descricao: asString(entry.descricao ?? activity),
        };
      }),
    };
  });
}

function parseChecklistDraft(value: string | undefined): ChecklistTopic[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as ChecklistTopic[] : [];
  } catch {
    return [];
  }
}

function firstContact(value: unknown) {
  return Array.isArray(value) && value[0] ? asRecord(value[0]) : {};
}

function fieldsFor(entity: CatalogEntity, options: { clients: FieldOption[]; units: FieldOption[]; assets: FieldOption[]; cities: string[] }): FieldDefinition[] {
  const systemOptions = [
    { value: "ar-condicionado", label: "Ar-condicionado" },
    { value: "eletrica", label: "Elétrica" },
    { value: "iluminacao-emergencia", label: "Iluminação e emergência" },
    { value: "hidraulica", label: "Hidráulica" },
    { value: "outro", label: "Outro" },
  ];
  switch (entity) {
    case "clientes":
      return [
        { name: "razaoSocial", label: "Razão social", required: true },
        { name: "cnpj", label: "CNPJ (14 dígitos)", required: true, placeholder: "00000000000000" },
        { name: "segmento", label: "Segmento", required: true },
        { name: "porteContrato", label: "Porte do contrato", type: "select", required: true, options: ["A", "B", "C"].map((value) => ({ value, label: value })) },
        { name: "slaRespostaMinutos", label: "SLA de resposta (minutos)", type: "number", required: true },
        { name: "slaSolucaoMinutos", label: "SLA de solução (minutos)", type: "number", required: true },
        { name: "valorHoraTecnica", label: "Valor hora técnica (R$)", type: "number", step: "0.01", required: true },
        { name: "valorMensal", label: "Valor mensal (R$)", type: "number", step: "0.01", required: true },
        { name: "contatoNome", label: "Nome do contato" },
        { name: "contatoEmail", label: "E-mail do contato", type: "email" },
        { name: "contatoTelefone", label: "WhatsApp do contato (E.164)", placeholder: "+5511999999999" },
      ];
    case "unidades":
      return [
        { name: "nome", label: "Nome da unidade", required: true },
        { name: "logradouro", label: "Logradouro", required: true },
        { name: "numero", label: "Número", required: true },
        { name: "complemento", label: "Complemento" },
        { name: "bairro", label: "Bairro" },
        { name: "cep", label: "CEP", required: true },
        { name: "cidade", label: "Cidade", required: true },
        { name: "uf", label: "UF", required: true, placeholder: "SP" },
        { name: "latitude", label: "Latitude", type: "number", step: "any" },
        { name: "longitude", label: "Longitude", type: "number", step: "any" },
        { name: "responsavelNome", label: "Responsável" },
        { name: "responsavelEmail", label: "E-mail do responsável", type: "email" },
        { name: "responsavelTelefone", label: "Telefone do responsável (E.164)", placeholder: "+5511999999999" },
        { name: "whatsappAutorizados", label: "WhatsApps autorizados (separe por vírgula)", placeholder: "+5511999999999, +5511888888888" },
      ];
    case "ativos":
      return [
        { name: "clienteId", label: "Cliente", type: "select", required: true, options: options.clients },
        { name: "unidadeId", label: "Unidade", type: "select", required: true, options: options.units },
        { name: "sistema", label: "Sistema", type: "select", required: true, options: systemOptions },
        { name: "tipo", label: "Tipo de equipamento", required: true },
        { name: "identificacao", label: "Identificação", required: true },
        { name: "observacoes", label: "Observações", type: "textarea" },
      ];
    case "tecnicos":
      return [
        { name: "usuarioUid", label: "UID do usuário autenticado", required: true },
        { name: "whatsapp", label: "WhatsApp (E.164)", required: true, placeholder: "+5511999999999" },
        { name: "cidadesAtendidas", label: "Cidades atendidas", type: "checkboxes", required: true, options: options.cities.map((city) => ({ value: city, label: city })) },
        { name: "especialidades", label: "Especialidades", type: "checkboxes", required: true, options: [
          { value: "ar-condicionado", label: "Ar-condicionado" },
          { value: "eletrica", label: "Elétrica" },
          { value: "hidraulica", label: "Hidráulica" },
          { value: "civil", label: "Civil" },
        ] },
      ];
    case "planosPreventivos":
      return [
        { name: "clienteId", label: "Cliente", type: "select", required: true, options: options.clients },
        { name: "unidadeId", label: "Unidade", type: "select", required: true, options: options.units },
        { name: "ativoId", label: "Ativo (opcional)", type: "select", options: [{ value: "", label: "Sem ativo específico" }, ...options.assets] },
        { name: "sistema", label: "Sistema", type: "select", required: true, options: systemOptions },
        { name: "periodicidade", label: "Periodicidade", type: "select", required: true, options: ["semanal", "quinzenal", "mensal", "bimestral", "trimestral", "semestral", "anual"].map((value) => ({ value, label: value })) },
        { name: "checklist", label: "Tópicos e atividades do checklist", type: "checklist-topics", required: true },
        { name: "proximaExecucao", label: "Próxima execução", type: "date", required: true },
        { name: "tecnicoId", label: "UID do técnico padrão (opcional)" },
        { name: "equipeId", label: "Equipe padrão (opcional)" },
      ];
    case "usuarios":
      return [
        { name: "nome", label: "Nome", required: true },
        { name: "email", label: "E-mail", type: "email", required: true },
        { name: "telefone", label: "Telefone / WhatsApp (E.164)", placeholder: "+5511999999999", requiredForRole: "tecnico" },
        { name: "role", label: "Perfil", type: "select", required: true, options: [
          { value: "analista", label: "Analista" },
          { value: "tecnico", label: "Técnico" },
          { value: "cliente", label: "Cliente" },
          { value: "administrador", label: "Administrador" },
        ] },
        { name: "clienteId", label: "Cliente vinculado (obrigatório para cliente)", type: "select", options: [{ value: "", label: "Selecione um cliente" }, ...options.clients], requiredForRole: "cliente", onlyRole: "cliente" },
        { name: "cidadesAtendidas", label: "Cidades atendidas", type: "checkboxes", options: options.cities.map((city) => ({ value: city, label: city })), onlyRole: "tecnico", requiredForRole: "tecnico" },
        { name: "especialidades", label: "Especialidades", type: "checkboxes", options: [
          { value: "ar-condicionado", label: "Ar-condicionado" },
          { value: "eletrica", label: "Elétrica" },
          { value: "hidraulica", label: "Hidráulica" },
          { value: "civil", label: "Civil" },
        ], onlyRole: "tecnico", requiredForRole: "tecnico" },
        { name: "outraCidadeAtiva", label: "Outra cidade", type: "checkbox-toggle", onlyRole: "tecnico" },
        { name: "outraCidade", label: "Nome da outra cidade", placeholder: "Digite o nome da cidade", onlyRole: "tecnico", showWhen: { field: "outraCidadeAtiva", value: "true" } },
      ];
  }
}

function formSchemaFor(entity: CatalogEntity) {
  switch (entity) {
    case "clientes": return clientFormSchema;
    case "unidades": return unitFormSchema;
    case "ativos": return assetFormSchema;
    case "tecnicos": return technicianFormSchema;
    case "planosPreventivos": return preventivePlanFormSchema;
    case "usuarios": return existingUserFormSchema;
  }
}

function formDefaults(entity: CatalogEntity, record: CatalogRecord | null): CatalogDraft {
  const data: Record<string, unknown> = record ?? {};
  const address = asRecord(data.endereco);
  const coordinates = asRecord(data.coordenadas);
  const contact = firstContact(entity === "clientes" ? data.contatos : data.responsaveis);
  const common: CatalogDraft = {};
  for (const field of fieldsFor(entity, { clients: [], units: [], assets: [], cities: [] })) common[field.name] = "";

  switch (entity) {
    case "clientes":
      return {
        ...common,
        razaoSocial: asString(data.razaoSocial),
        cnpj: asString(data.cnpj),
        segmento: asString(data.segmento),
        porteContrato: asString(data.porteContrato) || "B",
        slaRespostaMinutos: nestedString(data.sla, "respostaMinutos"),
        slaSolucaoMinutos: nestedString(data.sla, "solucaoMinutos"),
        valorHoraTecnica: toReais(data.valorHoraTecnicaCentavos),
        valorMensal: toReais(data.valorMensalCentavos),
        contatoNome: asString(contact.nome),
        contatoEmail: asString(contact.email),
        contatoTelefone: asString(contact.telefone),
      };
    case "unidades":
      return {
        ...common,
        clienteId: asString(data.clienteId),
        nome: asString(data.nome),
        logradouro: asString(address.logradouro),
        numero: asString(address.numero),
        complemento: asString(address.complemento),
        bairro: asString(address.bairro),
        cep: asString(address.cep),
        cidade: asString(address.cidade),
        uf: asString(address.uf),
        latitude: asString(coordinates.latitude),
        longitude: asString(coordinates.longitude),
        responsavelNome: asString(contact.nome),
        responsavelEmail: asString(contact.email),
        responsavelTelefone: asString(contact.telefone),
        whatsappAutorizados: commaSeparated(data.whatsappAutorizados),
      };
    case "ativos":
      return {
        ...common,
        clienteId: asString(data.clienteId),
        unidadeId: asString(data.unidadeId),
        sistema: asString(data.sistema) || "ar-condicionado",
        tipo: asString(data.tipo),
        identificacao: asString(data.identificacao),
        observacoes: asString(data.observacoes),
      };
    case "tecnicos":
      return {
        ...common,
        usuarioUid: asString(data.usuarioUid || data.id),
        whatsapp: asString(data.whatsapp),
        cidadesAtendidas: commaSeparated(data.cidadesAtendidas),
        especialidades: commaSeparated(data.especialidades),
      };
    case "planosPreventivos":
      return {
        ...common,
        clienteId: asString(data.clienteId),
        unidadeId: asString(data.unidadeId),
        ativoId: asString(data.ativoId),
        sistema: asString(data.sistema) || "ar-condicionado",
        periodicidade: asString(data.periodicidade) || "mensal",
        checklist: JSON.stringify(normalizeChecklist(data.checklist)),
        proximaExecucao: asString(data.proximaExecucao).slice(0, 10),
        tecnicoId: asString(data.tecnicoId),
        equipeId: asString(data.equipeId),
      };
    case "usuarios":
      return {
        ...common,
        nome: asString(data.nome),
        email: asString(data.email),
        telefone: asString(data.telefone),
        role: asString(data.role),
        clienteId: asString(data.clienteId),
        cidadesAtendidas: commaSeparated(data.cidadesAtendidas),
        especialidades: commaSeparated(data.especialidades),
        outraCidadeAtiva: "",
        outraCidade: "",
      };
  }
}

function recordTitle(entity: CatalogEntity, record: CatalogRecord) {
  switch (entity) {
    case "clientes": return asString(record.razaoSocial) || record.id;
    case "unidades": return asString(record.nome) || record.id;
    case "ativos": return `${asString(record.identificacao) || "Ativo"} · ${asString(record.tipo)}`;
    case "tecnicos": return asString(record.nome) || asString(record.usuarioUid) || record.id;
    case "planosPreventivos": return `${asString(record.sistema)} · ${asString(record.periodicidade)}`;
    case "usuarios": return asString(record.nome) || asString(record.email) || record.id;
  }
}

function recordDescription(entity: CatalogEntity, record: CatalogRecord) {
  switch (entity) {
    case "clientes": return `${asString(record.cnpj)} · Porte ${asString(record.porteContrato)} · ${record.ativo === false ? "Inativo" : "Ativo"}`;
    case "unidades": return `${asString(asRecord(record.endereco).cidade)} · ${asString(record.clienteId)}`;
    case "ativos": return `${asString(record.sistema)} · Unidade ${asString(record.unidadeId)}`;
    case "tecnicos": return `${asString(record.whatsapp)} · ${commaSeparated(record.cidadesAtendidas)}`;
    case "planosPreventivos": return `Unidade ${asString(record.unidadeId)} · Próxima execução ${asString(record.proximaExecucao)}`;
    case "usuarios": return record.role === "tecnico"
      ? `${asString(record.email)} · Técnico · ${commaSeparated(record.cidadesAtendidas)} · ${commaSeparated(record.especialidades)}`
      : `${asString(record.email)} · ${asString(record.role)} · ${record.ativo === false ? "Inativo" : "Ativo"}`;
  }
}

async function invokeList(entity: CatalogEntity): Promise<CatalogRecord[]> {
  if (!functions) throw new Error("Firebase Functions não está configurado.");
  const callable = httpsCallable<{ entity: CatalogEntity }, { items: CatalogRecord[] }>(functions, "listCatalog");
  const result = await callable({ entity });
  return result.data.items;
}

function QueryError({ message }: { message: string }) {
  return <p className="rounded-xl border border-red-300/20 bg-red-300/5 p-3 text-sm text-red-100" role="alert">{message}</p>;
}

export function CatalogPanel() {
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<PanelIdentity | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(Boolean(auth));
  const [section, setSection] = useState<PanelSection>("clientes");
  const [editing, setEditing] = useState<CatalogRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [passwordResetLink, setPasswordResetLink] = useState<string | null>(null);
  const [resetLinkCopied, setResetLinkCopied] = useState(false);
  const [resetLinkCopyError, setResetLinkCopyError] = useState(false);
  const [profileDraft, setProfileDraft] = useState({ nome: "", telefone: "" });
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setIdentity(null);
        setCheckingAuth(false);
        return;
      }
      try {
        const token = await user.getIdTokenResult();
        const roleClaim = token.claims.role;
        const role = typeof roleClaim === "string" && appRoles.includes(roleClaim as AppRole) ? roleClaim as AppRole : null;
        const clientClaim = token.claims.clienteId;
        setIdentity({ user, role, clienteId: typeof clientClaim === "string" ? clientClaim : null });
        setProfileDraft({ nome: user.displayName ?? "", telefone: user.phoneNumber ?? "" });
      } finally {
        setCheckingAuth(false);
      }
    });
  }, []);

  const isStaff = identity?.role === "administrador" || identity?.role === "analista";
  const availableSections = useMemo(() => {
    if (identity?.role === "administrador" || identity?.role === "analista") return staffSections;
    if (identity?.role === "cliente") return clientSections;
    if (identity?.role === "tecnico") {
      return [
        { id: "perfil" as const, label: "Meu perfil", icon: UserRound },
        { id: "unidades" as const, label: "Unidades atribuídas", icon: Building2 },
        { id: "ativos" as const, label: "Ativos atribuídos", icon: Wrench },
        { id: "planosPreventivos" as const, label: "Planos preventivos", icon: ClipboardList },
      ];
    }
    return [];
  }, [identity?.role]);
  const activeSection = availableSections.some((item) => item.id === section)
    ? section
    : availableSections[0]?.id ?? "perfil";

  const catalogQuery = useQuery({
    queryKey: ["catalog", identity?.user.uid, activeSection],
    queryFn: () => invokeList(activeSection as CatalogEntity),
    enabled: Boolean(identity?.role && activeSection !== "perfil" && activeSection !== "tecnicos"
      && !(identity.role === "tecnico" && activeSection === "planosPreventivos") && functions),
    staleTime: 15_000,
  });
  const needsRelations = isStaff && (activeSection === "unidades" || activeSection === "ativos" || activeSection === "planosPreventivos" || activeSection === "usuarios");
  const clientsQuery = useQuery({
    queryKey: ["catalog-options", "clientes"],
    queryFn: () => invokeList("clientes"),
    enabled: Boolean(needsRelations && functions),
    staleTime: 30_000,
  });
  const unitsQuery = useQuery({
    queryKey: ["catalog-options", "unidades"],
    queryFn: () => invokeList("unidades"),
    enabled: Boolean(isStaff && (activeSection === "ativos" || activeSection === "planosPreventivos") && functions),
    staleTime: 30_000,
  });
  const assetsQuery = useQuery({
    queryKey: ["catalog-options", "ativos"],
    queryFn: () => invokeList("ativos"),
    enabled: Boolean(isStaff && activeSection === "planosPreventivos" && functions),
    staleTime: 30_000,
  });
  const technicianCitiesQuery = useQuery({
    queryKey: ["catalog-options", "tecnicos", "cidades"],
    queryFn: async () => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const call = httpsCallable<undefined, { cidades: string[] }>(functions, "listTechnicianOptions");
      return (await call(undefined)).data.cidades;
    },
    enabled: Boolean(isStaff && activeSection === "usuarios" && functions),
    staleTime: 30_000,
  });

  const clients = clientsQuery.data ?? [];
  const units = unitsQuery.data ?? [];
  const assets = assetsQuery.data ?? [];
  const cities = technicianCitiesQuery.data ?? ["Barueri", "Santana de Parnaíba", "Osasco", "Itapevi"];
  const selectOptions = {
    clients: clients.map((record) => ({ value: record.id, label: asString(record.razaoSocial) || record.id })),
    units: units.map((record) => ({ value: record.id, scopeId: asString(record.clienteId), label: `${asString(record.nome)} · ${asString(asRecord(record.endereco).cidade)}` })),
    assets: assets.map((record) => ({ value: record.id, scopeId: asString(record.unidadeId), label: `${asString(record.identificacao)} · ${asString(record.tipo)}` })),
    cities,
  };

  const saveMutation = useMutation({
    mutationFn: async ({ entity, id, record }: { entity: CatalogEntity; id?: string; record: unknown }) => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      if (entity === "usuarios") {
        const callable = httpsCallable(functions, "assignExistingUser");
        return (await callable(record)).data as { uid: string; created: boolean; passwordResetLink: string | null };
      } else {
        const callable = httpsCallable(functions, "saveCatalogRecord");
        return (await callable({ entity, ...(id ? { id } : {}), record })).data;
      }
    },
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["catalog-options"] });
      setEditing(null);
      setCreating(false);
      setOperationError(null);
      setResetLinkCopied(false);
      setResetLinkCopyError(false);
      if (variables.entity === "usuarios") {
        const userResult = result as { created: boolean; restored: boolean; passwordResetLink: string | null };
        setPasswordResetLink(userResult.passwordResetLink);
        setNotice(userResult.created
          ? "Usuário criado e perfil atribuído. Compartilhe o link de definição de senha por um canal seguro."
          : userResult.restored
            ? "Conta restaurada e perfil atribuído. A reativação foi registrada na auditoria."
            : "Perfil vinculado à conta Firebase.");
      } else {
        setPasswordResetLink(null);
        setNotice("Cadastro salvo e auditado.");
      }
    },
    onError: (error) => {
      setOperationError(errorMessage(error));
      setNotice(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ entity, id }: { entity: CatalogEntity; id: string }) => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      await httpsCallable(functions, "softDeleteCatalogRecord")({ entity, id });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["catalog-options"] });
      setNotice("Cadastro excluído logicamente e registrado na auditoria.");
      setOperationError(null);
    },
    onError: (error) => {
      setOperationError(errorMessage(error));
      setNotice(null);
    },
  });

  const profileMutation = useMutation({
    mutationFn: async (data: { nome: string; telefone?: string }) => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      await httpsCallable(functions, "updateOwnProfile")(data);
    },
    onSuccess: async () => {
      await identity?.user.reload();
      setProfileMessage("Perfil atualizado e auditado.");
      setProfileError(null);
    },
    onError: (error) => {
      setProfileError(errorMessage(error));
      setProfileMessage(null);
    },
  });

  const handleSignOut = async () => {
    if (auth) await signOut(auth);
  };

  const copyPasswordResetLink = async () => {
    if (!passwordResetLink) return;
    setResetLinkCopyError(false);
    try {
      await navigator.clipboard.writeText(passwordResetLink);
      setResetLinkCopied(true);
    } catch {
      setResetLinkCopied(false);
      setResetLinkCopyError(true);
    }
  };

  if (checkingAuth) {
    return <main className="grid min-h-screen place-items-center text-sm text-muted" role="status">Verificando acesso…</main>;
  }
  if (!identity) {
    return (
      <main className="grid min-h-screen place-items-center px-5">
        <section className="auth-card max-w-lg p-8 text-center">
          <h1 className="text-xl font-bold">Entre para acessar o painel</h1>
          <p className="mt-2 text-sm text-muted">A autenticação é obrigatória; o acesso aos dados também é validado no backend.</p>
          <Link className="panel-link mt-6 inline-flex" href="/">Voltar ao login</Link>
        </section>
      </main>
    );
  }
  if (!identity.role) {
    return (
      <main className="grid min-h-screen place-items-center px-5">
        <section className="auth-card max-w-lg p-8 text-center">
          <h1 className="text-xl font-bold">Perfil pendente</h1>
          <p className="mt-2 text-sm text-muted">Peça a um administrador para vincular seu perfil antes de abrir o painel.</p>
          <Button className="mt-6 w-full" variant="secondary" onClick={handleSignOut}>Encerrar sessão</Button>
        </section>
      </main>
    );
  }
  if (identity.role === "cliente" && !identity.clienteId) {
    return <main className="grid min-h-screen place-items-center px-5"><section className="auth-card max-w-lg p-8 text-center"><h1 className="text-xl font-bold">Conta sem vínculo</h1><p className="mt-2 text-sm text-muted">O acesso está bloqueado até que o administrador vincule esta conta a um cliente.</p></section></main>;
  }

  const sectionLabel = availableSections.find((item) => item.id === activeSection)?.label ?? "Meu perfil";
  const records = catalogQuery.data ?? [];
  const formError = catalogQuery.error ? errorMessage(catalogQuery.error) : null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-surface/90 px-4 py-4 sm:px-7">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <Link href="/" className="brand-word">resolv<span>.tec</span></Link>
            <p className="mt-1 text-xs text-muted">Painel de cadastros · {roleLabels[identity.role]}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted sm:inline">{identity.user.displayName || identity.user.email}</span>
            <Button type="button" variant="secondary" onClick={handleSignOut}>
              <LogOut size={16} aria-hidden="true" /> Sair
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-border bg-surface p-3">
          <p className="px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-muted">Cadastros</p>
          <nav className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Seções do painel">
            {availableSections.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { setSection(item.id); setEditing(null); setCreating(false); setNotice(null); setOperationError(null); setPasswordResetLink(null); }}
                  aria-current={activeSection === item.id ? "page" : undefined}
                  className={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold transition-colors ${activeSection === item.id ? "bg-[#a4f101]/10 text-accent" : "text-muted hover:bg-white/5 hover:text-foreground"}`}
                >
                  <Icon size={17} aria-hidden="true" /> {item.label}
                </button>
              );
            })}
          </nav>
          <Link href="/" className="mt-3 flex items-center gap-2 border-t border-border px-3 pt-4 text-xs font-semibold text-muted hover:text-foreground">
            <ArrowLeft size={14} aria-hidden="true" /> Voltar ao acesso
          </Link>
        </aside>

        <section className="min-w-0">
          {activeSection === "perfil" ? (
            <section className="rounded-2xl border border-border bg-surface p-5 sm:p-7">
              <p className="eyebrow"><span /> PERFIL DO TÉCNICO</p>
              <h1 className="mt-3 text-2xl font-bold tracking-tight">Meu perfil</h1>
              <p className="mt-2 text-sm text-muted">Atualize apenas seus dados básicos; permissões continuam definidas pelo Firebase.</p>
              <form className="mt-6 grid max-w-2xl gap-4 sm:grid-cols-2" onSubmit={(event) => {
                event.preventDefault();
                const parsed = technicianSelfProfileSchema.safeParse(profileDraft);
                if (!parsed.success) { setProfileError(parsed.error.issues[0]?.message ?? "Revise os campos."); return; }
                profileMutation.mutate(parsed.data);
              }}>
                <label className="field-label">Nome
                  <input className="catalog-input mt-2" value={profileDraft.nome} onChange={(event) => setProfileDraft((current) => ({ ...current, nome: event.target.value }))} required />
                </label>
                <label className="field-label">Telefone (E.164)
                  <input className="catalog-input mt-2" value={profileDraft.telefone} onChange={(event) => setProfileDraft((current) => ({ ...current, telefone: event.target.value }))} placeholder="+5511999999999" />
                </label>
                <p className="text-xs text-muted sm:col-span-2">E-mail: {identity.user.email}</p>
                {profileError && <QueryError message={profileError} />}
                {profileMessage && <p className="rounded-xl border border-accent/20 bg-accent/5 p-3 text-sm text-accent" role="status">{profileMessage}</p>}
                <Button className="sm:col-span-2" disabled={profileMutation.isPending}>{profileMutation.isPending ? "Salvando…" : "Salvar meu perfil"}</Button>
              </form>
            </section>
          ) : activeSection === "tecnicos" ? (
            <TechnicianAssignmentPanel />
          ) : activeSection === "planosPreventivos" && identity.role === "tecnico" ? (
            <PreventiveExecutionPanel technicianUid={identity.user.uid} />
          ) : (
            <>
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="eyebrow"><span /> FASE 2 · CADASTROS</p>
                  <h1 className="mt-3 text-2xl font-bold tracking-tight">{sectionLabel}</h1>
                  <p className="mt-2 text-sm text-muted">Dados salvos por Cloud Functions com autorização e auditoria.</p>
                </div>
                {isStaff && (
                  <Button type="button" onClick={() => { setEditing(null); setCreating(true); setNotice(null); setOperationError(null); setPasswordResetLink(null); setResetLinkCopied(false); setResetLinkCopyError(false); }}>
                    <FilePlus2 size={16} aria-hidden="true" /> Novo cadastro
                  </Button>
                )}
              </div>

              {notice && <p className="mt-5 rounded-xl border border-accent/20 bg-accent/5 p-3 text-sm text-accent" role="status">{notice}</p>}
              {passwordResetLink && (
                <div className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/5 p-4">
                  <p className="text-sm font-bold text-amber-100">Link temporário de definição de senha</p>
                  <p className="mt-1 text-xs text-amber-100/80">Compartilhe apenas com o usuário por um canal seguro. O link não é salvo no cadastro.</p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input className="catalog-input min-w-0 flex-1" aria-label="Link temporário de definição de senha" readOnly value={passwordResetLink} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
                    <Button type="button" variant="secondary" className="shrink-0" onClick={() => void copyPasswordResetLink()}>
                      {resetLinkCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                      {resetLinkCopied ? "Copiado" : "Copiar link"}
                    </Button>
                  </div>
                  {resetLinkCopyError && <p className="mt-2 text-xs text-amber-100" role="status">Não foi possível copiar automaticamente. Clique no campo para selecionar o link e copie manualmente.</p>}
                </div>
              )}
              {operationError && <div className="mt-5"><QueryError message={operationError} /></div>}
              {formError && <div className="mt-5"><QueryError message={formError} /></div>}

              {(creating || editing) && isStaff && (
                <div className="mt-6 rounded-2xl border border-border bg-surface p-5 sm:p-7">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold">{editing ? "Editar cadastro" : activeSection === "usuarios" ? "Criar ou vincular usuário" : "Novo cadastro"}</h2>
                      {activeSection === "usuarios" && <p className="mt-1 text-xs text-muted">Se a conta ainda não existir, será criada sem senha. Uma conta excluída logicamente poderá ser restaurada por um administrador, com auditoria. O formulário retorna um link temporário para contas novas; não informe senhas aqui.</p>}
                    </div>
                    <button className="text-sm text-muted hover:text-foreground" type="button" onClick={() => { setEditing(null); setCreating(false); }}>Cancelar</button>
                  </div>
                  <CatalogRecordForm
                    key={`${activeSection}:${editing?.id ?? "new"}`}
                    entity={activeSection as CatalogEntity}
                    actorRole={identity.role}
                    record={editing}
                    fields={fieldsFor(activeSection as CatalogEntity, selectOptions)}
                    pending={saveMutation.isPending}
                    onCancel={() => { setEditing(null); setCreating(false); }}
                    onSave={(record) => saveMutation.mutate({ entity: activeSection as CatalogEntity, id: editing?.id, record })}
                  />
                </div>
              )}

              {catalogQuery.isLoading ? (
                <div className="mt-6 rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted" role="status">Carregando cadastros…</div>
              ) : records.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-border bg-surface p-8 text-center">
                  <Archive className="mx-auto text-muted" size={26} aria-hidden="true" />
                  <p className="mt-3 font-semibold">Nenhum registro encontrado</p>
                  <p className="mt-1 text-sm text-muted">{isStaff ? "Crie o primeiro cadastro desta seção." : "Ainda não há registros vinculados à sua conta."}</p>
                </div>
              ) : (
                <div className="mt-6 grid gap-3 md:grid-cols-2">
                  {records.map((record) => (
                    <article key={record.id} className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="truncate font-bold">{recordTitle(activeSection as CatalogEntity, record)}</h2>
                          <p className="mt-1 text-sm text-muted">{recordDescription(activeSection as CatalogEntity, record)}</p>
                          {activeSection === "clientes" && <p className="mt-2 text-xs text-muted">Mensalidade: {brlCurrency(Number(record.valorMensalCentavos ?? 0))}</p>}
                          {activeSection === "usuarios" && <p className="mt-2 truncate text-xs text-muted">UID: {record.id}</p>}
                        </div>
                        {isStaff && (
                          <div className="flex shrink-0 gap-1">
                            <button type="button" className="icon-action" aria-label={`Editar ${recordTitle(activeSection as CatalogEntity, record)}`} onClick={() => { setEditing(record); setCreating(false); setNotice(null); setOperationError(null); }}>
                              <Pencil size={16} aria-hidden="true" />
                            </button>
                            {identity.role === "administrador" && (
                              <button type="button" className="icon-action danger-action" aria-label={`Excluir ${recordTitle(activeSection as CatalogEntity, record)}`} disabled={deleteMutation.isPending} onClick={() => {
                                if (window.confirm(`Excluir logicamente “${recordTitle(activeSection as CatalogEntity, record)}”? A ação será auditada e não apagará fisicamente o registro.`)) {
                                  deleteMutation.mutate({ entity: activeSection as CatalogEntity, id: record.id });
                                }
                              }}>
                                <Trash2 size={16} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function CatalogRecordForm({
  entity,
  actorRole,
  record,
  fields,
  pending,
  onCancel,
  onSave,
}: {
  entity: CatalogEntity;
  actorRole: AppRole;
  record: CatalogRecord | null;
  fields: FieldDefinition[];
  pending: boolean;
  onCancel: () => void;
  onSave: (record: unknown) => void;
}) {
  const defaults = useMemo(() => formDefaults(entity, record), [entity, record]);
  const { register, handleSubmit, setError, clearErrors, control, setValue, formState: { errors } } = useForm<CatalogDraft>({
    resolver: zodResolver(catalogDraftSchema),
    defaultValues: defaults,
  });
  const selectedClientId = useWatch({ control, name: "clienteId" });
  const selectedUnitId = useWatch({ control, name: "unidadeId" });
  const selectedRole = useWatch({ control, name: "role" });
  const watchedDraft = useWatch({ control }) as CatalogDraft;
  const visibleFields = fields
    .filter((field) => !field.onlyRole || field.onlyRole === selectedRole)
    .filter((field) => !field.showWhen || watchedDraft[field.showWhen.field] === field.showWhen.value)
    .map((field) => {
    if (field.name === "unidadeId" && selectedClientId) {
      return { ...field, options: field.options?.filter((option) => option.scopeId === selectedClientId) };
    }
    if (field.name === "ativoId" && selectedUnitId) {
      return { ...field, options: field.options?.filter((option) => !option.scopeId || option.scopeId === selectedUnitId) };
    }
    if (entity === "usuarios" && actorRole === "analista" && field.name === "role") {
      return { ...field, options: field.options?.filter((option) => option.value !== "administrador") };
    }
    return field;
  });

  const submit = (values: CatalogDraft) => {
    clearErrors("root.validation");
    const parsed = formSchemaFor(entity).safeParse(values);
    if (!parsed.success) {
      setError("root.validation", { type: "manual", message: parsed.error.issues[0]?.message ?? "Revise os campos obrigatórios." });
      return;
    }
    onSave(parsed.data);
  };

  return (
    <form className="mt-6" onSubmit={handleSubmit(submit)} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {visibleFields.map((field) => {
          const registration = register(field.name);
          const invalid = Boolean(errors[field.name]);
          const required = Boolean(field.required || (field.requiredForRole && field.requiredForRole === selectedRole));
          if (field.type === "checklist-topics") {
            const topics = parseChecklistDraft(watchedDraft[field.name]);
            const saveTopics = (next: ChecklistTopic[]) => setValue(field.name, JSON.stringify(next), { shouldDirty: true, shouldValidate: true });
            return (
              <fieldset key={field.name} className="rounded-xl border border-border p-3 sm:col-span-2" aria-invalid={invalid}>
                <input type="hidden" {...registration} />
                <legend className="px-1 text-xs font-semibold text-[#d7ddda]">{field.label}{required ? " *" : ""}</legend>
                <div className="mt-3 grid gap-3">
                  {topics.map((topic, topicIndex) => (
                    <section key={topic.id} className="rounded-xl border border-border bg-background/50 p-3 sm:p-4">
                      <div className="flex items-center gap-2">
                        <label className="field-label min-w-0 flex-1">Tópico {topicIndex + 1}
                          <input
                            className="catalog-input mt-2"
                            value={topic.titulo}
                            maxLength={120}
                            placeholder="Ex.: Segurança e Estrutura"
                            onChange={(event) => saveTopics(topics.map((item) => item.id === topic.id ? { ...item, titulo: event.target.value } : item))}
                          />
                        </label>
                        <Button type="button" variant="secondary" aria-label={`Remover tópico ${topicIndex + 1}`} onClick={() => saveTopics(topics.filter((item) => item.id !== topic.id))}>Remover</Button>
                      </div>
                      <div className="mt-3 grid gap-2">
                        {topic.atividades.map((activity, activityIndex) => (
                          <div key={activity.id} className="flex items-center gap-2">
                            <label className="field-label min-w-0 flex-1">Atividade {activityIndex + 1}
                              <input
                                className="catalog-input mt-1"
                                value={activity.descricao}
                                maxLength={300}
                                placeholder="Descreva o que o técnico deve verificar"
                                onChange={(event) => saveTopics(topics.map((item) => item.id === topic.id ? {
                                  ...item,
                                  atividades: item.atividades.map((entry) => entry.id === activity.id ? { ...entry, descricao: event.target.value } : entry),
                                } : item))}
                              />
                            </label>
                            <Button type="button" variant="secondary" aria-label={`Remover atividade ${activityIndex + 1} do tópico ${topicIndex + 1}`} onClick={() => saveTopics(topics.map((item) => item.id === topic.id ? { ...item, atividades: item.atividades.filter((entry) => entry.id !== activity.id) } : item))}>×</Button>
                          </div>
                        ))}
                      </div>
                      <Button type="button" variant="secondary" className="mt-3" onClick={() => saveTopics(topics.map((item) => item.id === topic.id ? { ...item, atividades: [...item.atividades, { id: newChecklistId("atividade"), descricao: "" }] } : item))}>Adicionar atividade</Button>
                    </section>
                  ))}
                </div>
                <Button type="button" variant="secondary" className="mt-3" onClick={() => saveTopics([...topics, createChecklistTopic()])}>Adicionar tópico</Button>
                {invalid && <span className="mt-2 block text-xs text-red-200">Revise os tópicos e atividades obrigatórios.</span>}
              </fieldset>
            );
          }
          if (field.type === "checkboxes") {
            const checkedValues = new Set((watchedDraft[field.name] ?? "").split(/[;,]/).map((value) => value.trim()).filter(Boolean));
            return (
              <fieldset key={field.name} className="rounded-xl border border-border p-3 sm:col-span-2" aria-invalid={invalid}>
                <input type="hidden" {...registration} />
                <legend className="px-1 text-xs font-semibold text-[#d7ddda]">{field.label}{required ? " *" : ""}</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(field.options ?? []).map((option) => (
                    <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground hover:bg-white/5">
                      <input
                        className="accent-[#A4F101]"
                        type="checkbox"
                        checked={checkedValues.has(option.value)}
                        onChange={(event) => {
                          const next = new Set(checkedValues);
                          if (event.target.checked) next.add(option.value);
                          else next.delete(option.value);
                          setValue(field.name, [...next].join(", "), { shouldDirty: true, shouldValidate: true });
                        }}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                {invalid && <span className="mt-1 block text-xs text-red-200">{String(errors[field.name]?.message ?? "Campo inválido.")}</span>}
              </fieldset>
            );
          }
          if (field.type === "checkbox-toggle") {
            const checked = watchedDraft[field.name] === "true";
            return (
              <label key={field.name} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 text-sm text-foreground sm:col-span-2">
                <input
                  type="checkbox"
                  className="accent-[#A4F101]"
                  checked={checked}
                  onChange={(event) => setValue(field.name, event.target.checked ? "true" : "", { shouldDirty: true, shouldValidate: true })}
                />
                {field.label}
              </label>
            );
          }
          const common = {
            id: `catalog-${field.name}`,
            className: `catalog-input mt-2 ${invalid ? "catalog-input-error" : ""}`,
            "aria-invalid": invalid,
            "aria-required": required,
            ...registration,
          };
          return (
            <label key={field.name} className={`field-label ${field.type === "textarea" ? "sm:col-span-2" : ""}`} htmlFor={common.id}>
              {field.label}{required ? " *" : ""}
              {field.type === "textarea" ? (
                <textarea {...common} rows={4} placeholder={field.placeholder} required={required} />
              ) : field.type === "select" ? (
                <select {...common} required={required}>
                  <option value="">Selecione…</option>
                  {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <input {...common} type={field.type ?? "text"} step={field.step} placeholder={field.placeholder} required={required} />
              )}
              {invalid && <span className="mt-1 block text-xs text-red-200">{String(errors[field.name]?.message ?? "Campo inválido.")}</span>}
            </label>
          );
        })}
      </div>
      {errors.root?.validation?.message && <div className="mt-4"><QueryError message={errors.root.validation.message} /></div>}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" disabled={pending}>{pending ? "Salvando…" : "Salvar cadastro"}</Button>
      </div>
    </form>
  );
}
