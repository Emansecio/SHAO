// Código fictício para revisão local. Não é executado pelo SHAO.
export interface Row { sku: string; qty: number; date: string }
export interface Repo { save(row: Row): Promise<void> }

export async function importBatch(rows: Row[], repo: Repo) {
  const errors: { line: number; field: string }[] = [];
  let imported = 0;
  for (const [i, row] of rows.entries()) {
    if (!row.sku) {
      errors.push({ line: i + 2, field: "sku" });
      continue;
    }
    await repo.save(row); // grava a cada iteração: falha posterior deixa linhas anteriores salvas
    imported++;
  }
  return { imported, rejected: errors.length };
}
