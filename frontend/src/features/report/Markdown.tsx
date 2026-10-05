// Markdown mínimo e seguro para relatórios do backend: só elementos React, nunca HTML cru.
import { Fragment, type ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-white/[0.06] px-1 py-px font-mono text-[0.9em] text-fg">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k} className="font-semibold text-fg">{t.slice(2, -2)}</strong>);
    else {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const safe = /^(https?:\/\/|\/|\.\/|#)/.test(href);
      out.push(
        safe ? (
          <a key={k} href={href} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
            {label}
          </a>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key} className="my-3 overflow-x-auto rounded-lg bg-ink-950/70 px-4 py-3 font-mono text-[12px] leading-[1.7] text-fg/85">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "mt-2 font-serif text-[24px] text-fg" : level === 2 ? "mt-5 font-serif text-[19px] text-fg" : "mt-4 text-[13.5px] font-semibold text-fg";
      blocks.push(<div key={key} role="heading" aria-level={level} className={cls}>{inline(h[2], key)}</div>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      // a lista termina quando o tipo de marcador muda (numerada ↔ marcadores)
      const same = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length && same.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      const start = ordered ? Number(line.match(/\d+/)![0]) : undefined;
      blocks.push(
        <List key={key} start={start} className={`my-2 space-y-1 pl-5 text-[13.5px] leading-relaxed text-fg/85 ${ordered ? "list-decimal" : "list-disc"} marker:text-fg-faint`}>
          {items.map((it, j) => {
            // listas de tarefa: "[x] item" / "[ ] item"
            const task = it.match(/^\[( |x|X)\]\s+(.*)$/);
            if (!task) return <li key={j}>{inline(it, `${key}-${j}`)}</li>;
            const done = task[1] !== " ";
            return (
              <li key={j} className="list-none -ml-5 flex gap-2">
                <span aria-hidden className={done ? "text-ok" : "text-fg-faint"}>{done ? "✓" : "○"}</span>
                <span className="sr-only">{done ? "feito: " : "pendente: "}</span>
                <span>{inline(task[2], `${key}-${j}`)}</span>
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key} className="my-2 text-[13.5px] leading-relaxed text-fg/85">
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && " "}
            {inline(p, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div>{blocks}</div>;
}
