import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  children: string;
}

function normalizeTransportEscapes(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const escapedBlockLines = lines.filter((line) => /^\\(?:#{1,6}\s|\|)/.test(line)).length;
  const escapedLineEndings = lines.filter((line) => /\\\s*$/.test(line)).length;

  // Some structured Agent responses arrive with every Markdown line escaped.
  // Only repair that repeated transport pattern so intentional escapes survive.
  if (escapedBlockLines < 2 && escapedLineEndings < 3) return markdown;

  return lines
    .map((line) => line
      .replace(/^\\(?=(?:#{1,6}\s|\|))/, "")
      .replace(/\\\s*$/, ""))
    .join("\n");
}

export function MarkdownContent({ children }: Props) {
  return (
    <div className="team-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeTransportEscapes(children)}
      </ReactMarkdown>
    </div>
  );
}
