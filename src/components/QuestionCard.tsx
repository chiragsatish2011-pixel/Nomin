import { useEffect, useState } from "react";
import type { Question } from "../lib/questions.js";

/**
 * The clarification card — one question at a time, options selectable by click
 * or number key, with "Other" for anything the agent did not think of.
 *
 * Answers are the user's decisions, so nothing is pre-selected and every
 * question can be skipped: a skipped question tells the agent to use its own
 * judgement rather than silently inventing an answer.
 */
export function QuestionCard({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: Question[];
  onSubmit: (answers: Record<string, string[]>) => void;
  onDismiss: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState("");

  const question = questions[index];
  const total = questions.length;

  const choose = (label: string) => {
    if (!question) return;
    setAnswers((prev) => {
      const current = prev[question.id] ?? [];
      if (question.multi) {
        const next = current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label];
        return { ...prev, [question.id]: next };
      }
      return { ...prev, [question.id]: [label] };
    });
  };

  const advance = (skip = false) => {
    if (!question) return;
    const picked = other.trim() ? [...(answers[question.id] ?? []), other.trim()] : answers[question.id];
    const next = skip ? { ...answers, [question.id]: [] } : { ...answers, [question.id]: picked ?? [] };
    setAnswers(next);
    setOther("");
    if (index + 1 < total) {
      setIndex(index + 1);
    } else {
      onSubmit(next);
    }
  };

  // Number keys pick an option — the fastest path through a set of questions.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!question || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const digit = Number(event.key);
      if (digit >= 1 && digit <= question.options.length) {
        event.preventDefault();
        choose(question.options[digit - 1]!.label);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [question, choose]);

  if (!question) return null;
  const selected = answers[question.id] ?? [];

  return (
    <section className="questions">
      <header className="questions-head">
        <span className="questions-count">
          {index + 1}/{total}
        </span>
        <h3>{question.question}</h3>
        <button className="questions-close" onClick={onDismiss} title="Dismiss">
          ✕
        </button>
      </header>

      <ul className="questions-options">
        {question.options.map((option, i) => (
          <li key={option.label}>
            <button
              className={selected.includes(option.label) ? "on" : ""}
              onClick={() => choose(option.label)}
            >
              <span className="option-text">
                <strong>{option.label}</strong>
                {option.detail && <em>{option.detail}</em>}
              </span>
              <span className="option-key">{i + 1}</span>
            </button>
          </li>
        ))}
        <li className="questions-other">
          <label>Other</label>
          <input
            value={other}
            placeholder="Type your own answer here"
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (selected.length > 0 || other.trim())) advance();
            }}
          />
        </li>
      </ul>

      <footer className="questions-foot">
        {question.multi && <span className="questions-hint">Pick as many as apply</span>}
        <button className="ghost" onClick={() => advance(true)}>
          Skip
        </button>
        <button
          className="primary"
          onClick={() => advance()}
          disabled={!selected.length && !other.trim()}
        >
          {index + 1 < total ? "Next" : "Send answers"}
        </button>
      </footer>
    </section>
  );
}
