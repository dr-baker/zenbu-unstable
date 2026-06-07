import type { Choice, ChoicePrompt, Node } from "./types";

const OPEN_PROJECT: Choice = {
  id: "open-project",
  label: "Open a project",
  next: "openProject",
};

const CONTINUE_PLAYGROUND: Choice = {
  id: "continue-playground",
  label: "Continue in playground",
  next: "continueSandbox",
};

const TOPIC_LABELS: Record<string, string> = {
  plugins: "Plugins",
  shortcuts: "Shortcuts",
};

/** Quest prompt at the end of each topic node. Offers the
 * unvisited topics; once all are seen, adds the terminal actions
 * (open a project / continue in playground). */
function suggestNext(args: {
  visited: Set<string>;
  current: string;
}): ChoicePrompt {
  const { visited, current } = args;
  const allTopics = ["plugins", "shortcuts"];
  const unvisited = allTopics.filter((t) => t !== current && !visited.has(t));

  const question = (() => {
    if (unvisited.length === 0) return "Ready to open a project?";
    if (current === "intro") return "Where would you like to start?";
    return "Anything else you want to see?";
  })();

  const opts: Choice[] = [];
  for (const topic of unvisited) {
    opts.push({ id: topic, label: TOPIC_LABELS[topic] ?? topic, next: topic });
  }
  if (unvisited.length === 0) {
    opts.push(OPEN_PROJECT);
    opts.push(CONTINUE_PLAYGROUND);
  }
  return { question, options: opts };
}

export const SCRIPT: Record<string, Node> = {
  intro: {
    id: "intro",
    items: [
      {
        kind: "text",
        text: "Welcome to Zenbu",
      },
      {
        kind: "text",
        text: "This is a hackable interface built on top of the pi coding agent.",
      },
      {
        kind: "text",
        text: "Every part of this app can be extended.",
      },
    ],
    next: ({ visited }) => suggestNext({ visited, current: "intro" }),
  },

  plugins: {
    id: "plugins",
    items: [
      {
        kind: "text",
        text: "The best way to learn about plugins is to see what they can do.\n\nTry enabling some to get started:",
      },
      { kind: "widget", widget: "recommended-plugins", awaitAck: true },
      {
        kind: "text",
        text: "Every single part of the app is made of just plugins. Anything can be modified. You can even ask an agent to make one for you.",
      },
      // Wrap-up only fires if this was the last topic visited.
      {
        kind: "text",
        text: "When you're ready, open a project to start working.",
        condition: ({ visited }) => visited.has("shortcuts"),
      },
    ],
    next: ({ visited }) => suggestNext({ visited, current: "plugins" }),
  },

  shortcuts: {
    id: "shortcuts",
    items: [
      {
        kind: "text",
        text: "Almost everything has a shortcut. Some of the most important:",
      },
      { kind: "widget", widget: "shortcuts", awaitAck: true },
      {
        kind: "text",
        text: "Any of these can be rebound from settings.",
      },
      // Wrap-up only fires if this was the last topic visited.
      {
        kind: "text",
        text: "When you're ready, open a project to start working.",
        condition: ({ visited }) => visited.has("plugins"),
      },
    ],
    next: ({ visited }) => suggestNext({ visited, current: "shortcuts" }),
  },

  // Entered when the user picks "Skip tutorial".
  "skip-prompt": {
    id: "skip-prompt",
    items: [],
    next: () => ({
      question: "How would you like to start?",
      options: [OPEN_PROJECT, CONTINUE_PLAYGROUND],
    }),
  },
};
