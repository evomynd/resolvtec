import { z } from "zod";
import { appRoleSchema, type AppRole } from "@resolvtec/shared";

export type { AppRole };

export const loginSchema = z.object({
  email: z.string().trim().email("Informe um e-mail válido."),
  password: z.string().min(1, "Informe sua senha."),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const appRoles = appRoleSchema.options;

export const roleLabels: Record<AppRole, string> = {
  administrador: "Administrador",
  analista: "Analista",
  tecnico: "Técnico",
  cliente: "Cliente",
};
