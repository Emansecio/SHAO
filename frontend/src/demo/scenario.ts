// Cenário fictício "Atlas": revisão local de código de um PR inventado.
// Falas são públicas e curtas; nenhuma análise ou teste aqui foi executado de verdade.
import type { Agent, Criterion, Evidence, ParticipantId, Tone } from "@/model/types";

export const MISSION = {
  project: "Atlas",
  pr: "PR #284",
  branch: "feature/bulk-import",
  title: "Importação em lote",
  subtitle: "Revisão local de código · leitura apenas",
};

export const HUMAN = { id: "user", name: "Você", hue: "#ecebe6" };

export const DEMO_META = { runId: "demo-atlas-284", title: MISSION.title, workspace: "~/demo/atlas (fictício)", createdAt: "2026-10-05T14:20:00" };
const DEMO_BASE = new Date(DEMO_META.createdAt).getTime();
/** Relógio fictício da demo: 1 s real ≈ 10 s de run. */
export const demoAt = (clock: number) => DEMO_BASE + clock * 10;

export const CORE_AGENTS: Agent[] = [
  {
    id: "orchestrator",
    name: "Orquestrador",
    role: "Coordenação",
    engine: "claude-code",
    parentId: null,
    hue: "#dcc59a",
    brief: "Divide o trabalho, cruza achados e conversa com você.",
  },
  {
    id: "maya",
    name: "Maya",
    role: "Código",
    engine: "claude-code",
    parentId: "orchestrator",
    hue: "#8fd3b6",
    brief: "Lê o fluxo de validação e persistência do diff.",
  },
  {
    id: "ivo",
    name: "Ivo",
    role: "Dependências",
    engine: "codex-cli",
    parentId: "orchestrator",
    hue: "#9db0f5",
    brief: "Confere lockfile, versões e impacto de pacotes.",
  },
  {
    id: "nia",
    name: "Nia",
    role: "Navegador · lab",
    engine: "claude-code",
    parentId: "orchestrator",
    hue: "#eba98c",
    brief: "Reproduz o fluxo no preview local com fixtures.",
  },
  {
    id: "rui",
    name: "Rui",
    role: "Revisor",
    engine: "codex-cli",
    parentId: "orchestrator",
    hue: "#c4a9ef",
    brief: "Contesta achados e fecha o parecer.",
  },
];

export const SPECIALISTS: Agent[] = [
  {
    id: "lia",
    name: "Lia",
    role: "Contrato de produto",
    engine: "claude-code",
    parentId: "orchestrator",
    hue: "#7fcfe0",
    brief: "Traduz a divergência técnica em comportamento para quem importa.",
    dynamic: true,
  },
  {
    id: "teo",
    name: "Teo",
    role: "Desempenho",
    engine: "codex-cli",
    parentId: "orchestrator",
    hue: "#d6d985",
    brief: "Estima custo de memória e tempo do parser em lotes grandes.",
    dynamic: true,
  },
];

export const INITIAL_CRITERIA: Criterion[] = [
  { id: "c-flow", label: "Fluxo de validação lido", owner: "maya", state: "open", note: "Aguardando leitura do diff" },
  { id: "c-deps", label: "Dependências conferidas", owner: "ivo", state: "open", note: "Lockfile ainda não comparado" },
  { id: "c-lab", label: "Lote misto reproduzido no lab", owner: "nia", state: "open", note: "Sem reprodução ainda" },
  { id: "c-counter", label: "Contraponto respondido", owner: "rui", state: "open", note: "Nenhuma divergência levantada" },
  { id: "c-contract", label: "Contrato de importação decidido", owner: "user", state: "open", note: "Depende da sua orientação" },
];

export const EVIDENCE: Record<string, Evidence> = {
  "ev-diff": {
    evidenceId: "ev-diff",
    agentId: "maya",
    kind: "diff",
    title: "Persistência dentro do loop",
    path: "src/import/import-service.ts",
    summary: "Cada linha válida é gravada antes de validar a seguinte.",
    body: `@@ -41,12 +41,19 @@ export async function importBatch(file: Upload) {
   const rows = await parseCsv(file);          // materializa o arquivo
   assertHeader(rows[0]);
+  let imported = 0;
   for (const row of rows.slice(1)) {
-    validated.push(validateRow(row));
+    const result = validateRow(row);
+    if (!result.ok) {
+      errors.push(result.error);
+      continue;
+    }
+    await repo.save(result.value);             // grava a cada iteração
+    imported++;
   }
-  await repo.saveAll(validated);
-  return { imported: validated.length };
+  return { imported, rejected: errors.length };
 }`,
  },
  "ev-lock": {
    evidenceId: "ev-lock",
    agentId: "ivo",
    kind: "lockfile",
    title: "csv-parse 5.5.6 → 5.6.0",
    path: "package-lock.json",
    summary: "Minor com erro por linha; nenhuma transitiva nova.",
    body: `  "node_modules/csv-parse": {
-   "version": "5.5.6",
+   "version": "5.6.0",
    "license": "MIT"
  }

  transitivas novas ........ 0
  licenças alteradas ....... 0
  changelog 5.6.0 .......... "on_record" expõe erro por linha`,
  },
  "ev-lab": {
    evidenceId: "ev-lab",
    agentId: "nia",
    kind: "lab",
    title: "Lote misto no preview local",
    path: "fixtures/lote-misto.csv",
    summary: "3 linhas entram, 1 é rejeitada; a tela só diz “concluída”.",
    body: `fixture: lote-misto.csv (4 linhas, linha 3 sem "sku")
alvo: preview local do Atlas · dados fictícios

→ POST /import            (local, simulado)
← 200 { "imported": 3, "rejected": 1 }

tela: "Importação concluída"
sem indicação de qual linha falhou
registros persistidos após o envio: 3`,
  },
  "ev-journey": {
    evidenceId: "ev-journey",
    agentId: "lia",
    kind: "note",
    title: "Jornada de reenvio",
    path: "notes/reenvio.md",
    summary: "Quem importa quer corrigir só a linha ruim e reenviar.",
    body: `Cenário: operador envia 2 000 linhas, 4 falham.

Parcial + relatório por linha
  · corrige 4 linhas, reenvia só elas
  · exige reenvio idempotente (sku + data)

Atômico
  · reenvia as 2 000 após corrigir
  · simples de explicar, caro para lotes grandes`,
  },
  "ev-perf": {
    evidenceId: "ev-perf",
    agentId: "teo",
    kind: "note",
    title: "Memória do parser",
    path: "notes/parser-memoria.md",
    summary: "Arquivo inteiro em memória; ok até ~5 mil linhas na fixture.",
    body: `estimativa sobre fixture sintética (não medido em produção)

linhas     memória aprox.   observação
1 000      ~4 MB            confortável
5 000      ~19 MB           ok
50 000     ~190 MB          trocar por stream

recomendação: limite explícito de 5 000 no contrato`,
  },
};

// ----- Passos do roteiro -----

export type Step =
  | { kind: "spawn"; gap: number; agent: Agent; by: ParticipantId }
  | {
      kind: "say";
      gap: number;
      key?: string;
      from: ParticipantId;
      to: ParticipantId[];
      text: string;
      tone?: Tone;
      replyTo?: string; // key de outra fala
      evidence?: string[];
    }
  | { kind: "act"; gap: number; agentId: string; label: string; detail: string; evidence?: string; duration: number }
  | { kind: "criterion"; gap: number; id: string; state: Criterion["state"]; note: string };

export const OPENING: Step[] = [
  ...CORE_AGENTS.map<Step>((agent, i) => ({ kind: "spawn", gap: i === 0 ? 300 : 260, agent, by: i === 0 ? "user" : "orchestrator" })),
  {
    kind: "say",
    gap: 500,
    key: "hello",
    from: "orchestrator",
    to: ["user"],
    tone: "brief",
    text: "Abri a revisão local do Atlas, PR #284. Dividi em quatro frentes: Maya no código, Ivo nas dependências, Nia reproduz no lab e Rui contesta o que aparecer. Te chamo quando houver divergência — pode me orientar a qualquer momento.",
  },
  {
    kind: "say",
    gap: 600,
    key: "brief",
    from: "orchestrator",
    to: ["maya", "ivo", "nia", "rui"],
    tone: "brief",
    text: "Escopo: branch feature/bulk-import, só leitura local. Publiquem a evidência junto com a fala e respondam entre vocês, não só para mim.",
  },
  { kind: "act", gap: 700, agentId: "maya", label: "Leu import-service.ts", detail: "Diff de 19 linhas no fluxo de importação", evidence: "ev-diff", duration: 1800 },
  {
    kind: "say",
    gap: 300,
    key: "maya-find",
    from: "maya",
    to: ["orchestrator", "rui"],
    tone: "finding",
    evidence: ["ev-diff"],
    text: "O cabeçalho é validado antes de gravar, ótimo. Mas cada linha é salva dentro do loop: se a quarta falhar, as três primeiras já estão no banco.",
  },
  { kind: "criterion", gap: 120, id: "c-flow", state: "met", note: "Gravação acontece por linha" },
  { kind: "act", gap: 500, agentId: "ivo", label: "Comparou package-lock.json", detail: "csv-parse sobe um minor; sem transitivas novas", evidence: "ev-lock", duration: 1600 },
  {
    kind: "say",
    gap: 300,
    key: "ivo-counter",
    from: "ivo",
    to: ["maya"],
    tone: "counterpoint",
    replyTo: "maya-find",
    evidence: ["ev-lock"],
    text: "Contraponto: gravar no loop não é bug por si. O csv-parse novo já entrega erro por linha — se o contrato for importação parcial, o seu achado vira comportamento esperado. A dúvida é o contrato, não o código.",
  },
  { kind: "criterion", gap: 120, id: "c-deps", state: "met", note: "Minor sem transitivas novas" },
  {
    kind: "say",
    gap: 700,
    key: "maya-agree",
    from: "maya",
    to: ["ivo"],
    tone: "agree",
    replyTo: "ivo-counter",
    text: "Justo. Então só peço uma coisa: a resposta precisa dizer quais linhas entraram. Hoje volta apenas a contagem.",
  },
  { kind: "act", gap: 500, agentId: "nia", label: "Reproduziu lote misto no lab", detail: "Fixture de 4 linhas no preview local · simulado", evidence: "ev-lab", duration: 2200 },
  {
    kind: "say",
    gap: 300,
    key: "nia-lab",
    from: "nia",
    to: ["maya", "ivo"],
    tone: "finding",
    evidence: ["ev-lab"],
    text: "Reproduzi no lab: três entram, uma é rejeitada, e a tela mostra só “Importação concluída”. Quem enviou não sabe qual linha corrigir.",
  },
  { kind: "criterion", gap: 120, id: "c-lab", state: "met", note: "3 gravadas, 1 rejeitada sem detalhe" },
  {
    kind: "say",
    gap: 800,
    key: "rui-counter",
    from: "rui",
    to: ["nia", "ivo"],
    tone: "counterpoint",
    replyTo: "nia-lab",
    text: "Eu não aprovaria nem reprovaria ainda. Se for parcial, falta relatório por linha; se for atômico, falta transação. Os dois são baratos — precisamos escolher um.",
  },
  { kind: "criterion", gap: 100, id: "c-counter", state: "progress", note: "Rui pediu uma escolha de contrato" },
  {
    kind: "say",
    gap: 700,
    key: "ivo-reply",
    from: "ivo",
    to: ["rui"],
    tone: "question",
    replyTo: "rui-counter",
    text: "Eu iria de parcial com relatório. Transação única num lote de 5 mil linhas segura lock por tempo demais.",
  },
  { kind: "criterion", gap: 100, id: "c-counter", state: "met", note: "Ivo respondeu: prefere parcial" },
  { kind: "criterion", gap: 100, id: "c-contract", state: "progress", note: "Parcial ou atômico? Aguarda você" },
  {
    kind: "say",
    gap: 700,
    key: "orq-ask",
    from: "orchestrator",
    to: ["user"],
    tone: "question",
    evidence: ["ev-diff", "ev-lab"],
    text: "Resumo: código e dependências estão ok. A divergência é de contrato — importação parcial (Ivo e Nia inclinados) ou atômica (Maya neutra). Você decide, ou posso chamar uma especialista de produto para propor.",
  },
];

export function specialistSteps(agent: Agent, announce = true): Step[] {
  const steps = agent.id === "lia" ? liaSteps(agent) : teoSteps(agent);
  return announce ? steps : steps.filter((st) => !(st.kind === "say" && st.key === "announce"));
}

function liaSteps(agent: Agent): Step[] {
  return [
      { kind: "spawn", gap: 200, agent, by: "orchestrator" },
      {
        kind: "say",
        gap: 400,
        key: "announce",
        from: "orchestrator",
        to: ["user"],
        tone: "brief",
        text: "Chamei a Lia para olhar o contrato pelo lado de quem importa. Ela vai conversar direto com Ivo e Maya.",
      },
      {
        kind: "say",
        gap: 500,
        key: "lia-brief",
        from: "orchestrator",
        to: ["lia"],
        tone: "brief",
        evidence: ["ev-lab"],
        text: "Lia: parcial ou atômico para a importação do Atlas? A reprodução da Nia está anexada.",
      },
      { kind: "act", gap: 500, agentId: "lia", label: "Mapeou a jornada de reenvio", detail: "Fixture de 2 000 linhas com 4 erros · simulado", evidence: "ev-journey", duration: 1700 },
      {
        kind: "say",
        gap: 300,
        key: "lia-rec",
        from: "lia",
        to: ["ivo", "maya", "nia"],
        tone: "counterpoint",
        replyTo: "lia-brief",
        evidence: ["ev-journey"],
        text: "Pra quem importa, parcial ganha: corrige quatro linhas e reenvia só elas. Mas o reenvio precisa ser idempotente, senão duplica as que já entraram.",
      },
      {
        kind: "say",
        gap: 600,
        from: "ivo",
        to: ["lia"],
        tone: "agree",
        replyTo: "lia-rec",
        text: "Boa. Chave natural sku + data no upsert resolve isso sem dependência nova.",
      },
      { kind: "criterion", gap: 100, id: "c-contract", state: "progress", note: "Lia propõe parcial + reenvio idempotente" },
      {
        kind: "say",
        gap: 600,
        key: "orq-confirm",
        from: "orchestrator",
        to: ["user"],
        tone: "question",
        evidence: ["ev-journey"],
        text: "Lia recomenda importação parcial com relatório por linha e reenvio idempotente. Confirma esse contrato?",
      },
  ];
}

function teoSteps(agent: Agent): Step[] {
  return [
    { kind: "spawn", gap: 200, agent, by: "orchestrator" },
    {
      kind: "say",
      gap: 400,
      key: "announce",
      from: "orchestrator",
      to: ["user"],
      tone: "brief",
      text: "Trouxe o Teo para estimar o custo do parser em lotes grandes. Ele responde ao Ivo.",
    },
    {
      kind: "say",
      gap: 500,
      key: "teo-brief",
      from: "orchestrator",
      to: ["teo"],
      tone: "brief",
      text: "Teo: o parser materializa o arquivo inteiro. Até onde isso aguenta?",
    },
    { kind: "act", gap: 500, agentId: "teo", label: "Estimou memória do parser", detail: "Fixture sintética de 1k a 50k linhas · simulado", evidence: "ev-perf", duration: 1700 },
    {
      kind: "say",
      gap: 300,
      key: "teo-find",
      from: "teo",
      to: ["ivo", "maya"],
      tone: "finding",
      replyTo: "teo-brief",
      evidence: ["ev-perf"],
      text: "Até 5 mil linhas fica tranquilo. Acima disso eu trocaria por stream — ou deixaria o limite explícito no contrato.",
    },
    {
      kind: "say",
      gap: 600,
      from: "ivo",
      to: ["teo"],
      tone: "agree",
      replyTo: "teo-find",
      text: "Anotado no parecer: limite de 5 mil linhas declarado, stream fica para depois.",
    },
  ];
}

// ----- Respostas DEMO ao humano -----

export interface HumanContext {
  addedSpecialists: string[];
  contractState: Criterion["state"];
  criteria: Criterion[];
  names: Record<string, string>;
}

export type HumanResponse = { steps: Step[]; addSpecialist?: string };

const has = (t: string, re: RegExp) => re.test(t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase());

function decide(kind: "parcial" | "atomico"): Step[] {
  const parcial = kind === "parcial";
  return [
    {
      kind: "say",
      gap: 350,
      from: "orchestrator",
      to: ["user"],
      tone: "decision",
      text: parcial
        ? "Combinado: importação parcial com relatório por linha e reenvio idempotente. Vou pedir à Maya o ajuste da recomendação e ao Rui o parecer final."
        : "Combinado: importação atômica, tudo ou nada. Vou pedir ao Ivo o impacto de lock e ao Rui o parecer final.",
    },
    {
      kind: "say",
      gap: 500,
      key: "orq-decision",
      from: "orchestrator",
      to: parcial ? ["maya", "rui"] : ["ivo", "rui"],
      tone: "decision",
      text: parcial ? "Decisão humana: parcial + relatório por linha. Fechem a recomendação." : "Decisão humana: atômico. Fechem a recomendação.",
    },
    parcial
      ? {
          kind: "say",
          gap: 600,
          key: "maya-rec",
          from: "maya",
          to: ["rui"],
          tone: "finding",
          replyTo: "orq-decision",
          evidence: ["ev-diff"],
          text: "Então mantemos o loop e devolvemos {linha, campo, motivo} para cada rejeição. Um teste de lote misto cobre o contrato.",
        }
      : {
          kind: "say",
          gap: 600,
          key: "maya-rec",
          from: "ivo",
          to: ["rui"],
          tone: "counterpoint",
          replyTo: "orq-decision",
          text: "Funciona se o lote tiver teto. Com transação única eu limitaria a mil linhas para não segurar lock.",
        },
    {
      kind: "say",
      gap: 600,
      from: "rui",
      to: ["orchestrator"],
      tone: "decision",
      replyTo: "maya-rec",
      text: parcial
        ? "Parecer: aprovar com ajustes — relatório por linha, upsert idempotente e teste de lote misto."
        : "Parecer: aprovar com ajustes — transação única, teto de mil linhas e teste de rollback.",
    },
    { kind: "criterion", gap: 100, id: "c-contract", state: "met", note: parcial ? "Parcial + relatório por linha" : "Atômico com teto de mil linhas" },
    {
      kind: "say",
      gap: 500,
      from: "orchestrator",
      to: ["user"],
      tone: "brief",
      text: "Todos os critérios estão cobertos. O parecer do Rui está na timeline do Conselho — nada foi aplicado ao repositório.",
    },
  ];
}

export function respondToHuman(text: string, ctx: HumanContext): HumanResponse {
  const decided = ctx.contractState === "met";

  if (!decided && has(text, /\b(confirm|confirmo|sim|ok|pode|fechado|de acordo)\b/) && ctx.addedSpecialists.includes("lia")) {
    return { steps: decide("parcial") };
  }
  if (!decided && has(text, /parcial/)) return { steps: decide("parcial") };
  if (!decided && has(text, /atomic|tudo ou nada|transac/)) return { steps: decide("atomico") };

  if (has(text, /especialista|produto|contrato|lia/) && !ctx.addedSpecialists.includes("lia")) {
    return {
      steps: [{ kind: "say", gap: 300, from: "orchestrator", to: ["user"], tone: "brief", text: "Faz sentido. Vou chamar a Lia, especialista em contrato de produto." }],
      addSpecialist: "lia",
    };
  }
  if (has(text, /desempenho|performance|memoria|lento|teo/) && !ctx.addedSpecialists.includes("teo")) {
    return {
      steps: [{ kind: "say", gap: 300, from: "orchestrator", to: ["user"], tone: "brief", text: "Boa pergunta. Vou trazer o Teo para estimar memória e tempo do parser." }],
      addSpecialist: "teo",
    };
  }

  if (has(text, /resum|status|onde|como esta|progresso/)) {
    const met = ctx.criteria.filter((c) => c.state === "met");
    const open = ctx.criteria.filter((c) => c.state !== "met");
    const line = open.length
      ? `Falta: ${open.map((c) => c.label.toLowerCase()).join("; ")}.`
      : "Nada pendente.";
    return {
      steps: [
        {
          kind: "say",
          gap: 300,
          from: "orchestrator",
          to: ["user"],
          tone: "brief",
          text: `Estamos em ${met.length} de ${ctx.criteria.length} critérios. ${line}`,
        },
      ],
    };
  }

  // Roteia a orientação para o par mais próximo do assunto.
  const target = has(text, /depend|lock|pacote|versao|csv-parse|licen/)
    ? "ivo"
    : has(text, /teste|lab|reproduz|tela|navegador|preview/)
      ? "nia"
      : has(text, /codigo|loop|valida|diff|funcao|erro/)
        ? "maya"
        : "rui";
  const replies: Record<string, string> = {
    ivo: "Recebido. Confiro de novo o changelog do csv-parse com esse foco e anoto no parecer.",
    nia: "Entendido. Monto mais um caso no lab com essa orientação — continua tudo em fixture local.",
    maya: "Ok, releio o trecho com esse olhar e aponto a linha exata se mudar algo.",
    rui: "Anotado como condição do parecer. Se alguém discordar, eu trago aqui.",
  };
  return {
    steps: [
      {
        kind: "say",
        gap: 300,
        from: "orchestrator",
        to: ["user"],
        tone: "brief",
        text: `Anotado. Encaminhei sua orientação para ${ctx.names[target]}${decided ? "" : " — e sigo esperando sua escolha de contrato (parcial ou atômico)"}.`,
      },
      { kind: "say", gap: 450, key: "fwd", from: "orchestrator", to: [target], tone: "brief", text: `Orientação humana: “${text.trim().slice(0, 140)}”` },
      { kind: "say", gap: 600, from: target, to: ["orchestrator"], tone: "agree", replyTo: "fwd", text: replies[target] },
    ],
  };
}
