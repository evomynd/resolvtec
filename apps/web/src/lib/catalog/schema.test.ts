import { describe, expect, it } from "vitest";
import { existingUserFormSchema, preventivePlanFormSchema } from "./schema";

describe("catalog callable payload schemas", () => {
  it("omits blank client and phone fields for non-client users", () => {
    const user = existingUserFormSchema.parse({
      nome: "Técnico de teste",
      email: "tecnico@example.test",
      telefone: "",
      role: "analista",
      clienteId: "",
      cidadesAtendidas: "",
      especialidades: "",
      outraCidadeAtiva: "",
      outraCidade: "",
    });

    expect(user).toEqual({ nome: "Técnico de teste", email: "tecnico@example.test", role: "analista" });
    expect(Object.hasOwn(user, "clienteId")).toBe(false);
    expect(Object.hasOwn(user, "telefone")).toBe(false);
  });

  it("preserves a required client link for client-role users", () => {
    const user = existingUserFormSchema.parse({
      nome: "Contato de cliente",
      email: "contato@example.test",
      telefone: "",
      role: "cliente",
      clienteId: "cliente-a",
      cidadesAtendidas: "",
      especialidades: "",
      outraCidadeAtiva: "",
      outraCidade: "",
    });

    expect(user.clienteId).toBe("cliente-a");
    expect(Object.hasOwn(user, "telefone")).toBe(false);
  });

  it("omits blank optional asset and technician assignments from preventive plans", () => {
    const plan = preventivePlanFormSchema.parse({
      clienteId: "cliente-a",
      unidadeId: "unidade-a",
      ativoId: "",
      sistema: "ar-condicionado",
      periodicidade: "mensal",
      checklist: "Inspecionar filtros",
      tecnicoId: "",
      equipeId: "",
      proximaExecucao: "2026-12-01",
    });

    expect(plan).not.toHaveProperty("ativoId");
    expect(plan).not.toHaveProperty("tecnicoId");
    expect(plan).not.toHaveProperty("equipeId");
    expect(plan.checklist).toEqual([{
      id: "topico-geral",
      titulo: "Checklist geral",
      atividades: [{ id: "atividade-1", descricao: "Inspecionar filtros" }],
    }]);
  });

  it("preserves multiple topics and their activities in a preventive plan", () => {
    const checklist = [
      { id: "seguranca", titulo: "Segurança e Estrutura", atividades: [{ id: "disjuntores", descricao: "Inspecionar disjuntores" }] },
      { id: "termografia", titulo: "Termografia e Inspeção Visual", atividades: [{ id: "temperatura", descricao: "Medir temperatura das conexões" }, { id: "cabos", descricao: "Verificar cabos" }] },
    ];
    const plan = preventivePlanFormSchema.parse({
      clienteId: "cliente-a",
      unidadeId: "unidade-a",
      ativoId: "",
      sistema: "eletrica",
      periodicidade: "mensal",
      checklist: JSON.stringify(checklist),
      tecnicoId: "",
      equipeId: "",
      proximaExecucao: "2026-12-01",
    });

    expect(plan.checklist).toEqual(checklist);
  });

  it("rejects duplicate topic identifiers", () => {
    expect(() => preventivePlanFormSchema.parse({
      clienteId: "cliente-a",
      unidadeId: "unidade-a",
      ativoId: "",
      sistema: "eletrica",
      periodicidade: "mensal",
      checklist: JSON.stringify([
        { id: "duplicado", titulo: "Tópico A", atividades: [{ id: "atividade-a", descricao: "Verificar A" }] },
        { id: "duplicado", titulo: "Tópico B", atividades: [{ id: "atividade-b", descricao: "Verificar B" }] },
      ]),
      tecnicoId: "",
      equipeId: "",
      proximaExecucao: "2026-12-01",
    })).toThrow();
  });
});
