import type { SkillCategory } from "../types/capability.js";

export interface CategoryDef {
  id: SkillCategory;
  label: string;
  icon: string;
  color: string;
}

export const SKILL_CATEGORIES: CategoryDef[] = [
  { id: "web", label: "Web", icon: "globe", color: "#6366f1" },
  { id: "communication", label: "Communication", icon: "mail", color: "#f59e0b" },
  { id: "file", label: "Files", icon: "folder", color: "#10b981" },
  { id: "data", label: "Data", icon: "database", color: "#8b5cf6" },
  { id: "developer", label: "Developer", icon: "code", color: "#ef4444" },
  { id: "productivity", label: "Productivity", icon: "calendar", color: "#3b82f6" },
  { id: "ai", label: "AI", icon: "sparkles", color: "#ec4899" },
];

/** @deprecated Use CategoryDef */
export type SkillCategoryDef = CategoryDef;
