import { z } from "zod";

export const appRoleSchema = z.enum(["administrador", "analista", "tecnico", "cliente"]);
export type AppRole = z.infer<typeof appRoleSchema>;

export const userProfileSchema = z.object({
  uid: z.string().min(1),
  nome: z.string().trim().min(1),
  email: z.string().trim().email(),
  telefone: z.string().trim().optional(),
  role: appRoleSchema,
  clienteId: z.string().min(1).optional(),
  ativo: z.boolean().default(true),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).superRefine((profile, context) => {
  if (profile.role === "cliente" && !profile.clienteId) {
    context.addIssue({ code: "custom", path: ["clienteId"], message: "Perfil de cliente exige clienteId." });
  }
  if (profile.role !== "cliente" && profile.clienteId) {
    context.addIssue({ code: "custom", path: ["clienteId"], message: "Somente clientes podem ter clienteId." });
  }
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const brlCurrency = (centavos: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(centavos / 100);

export const saoPauloDateTime = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
