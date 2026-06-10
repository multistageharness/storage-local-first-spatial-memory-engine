/**
 * Curated benchmark golden dataset #2 — the React UI component-library
 * ecosystem. Eight library profiles form the knowledge base; the libraries
 * overlap heavily in vocabulary (components, styling, CSS, complex,
 * Tailwind, unstyled…), which makes them natural distractors for each
 * other — no synthetic lure documents are needed.
 *
 * Distribution (20 cases): 11 common (55%), 5 distractor (25%),
 * 2 multi-hop (10%), 2 no-answer (10%).
 */
import type { BenchmarkDataset } from '../eval/benchmark.js';
import type { CorpusDoc } from '../eval/goldens.js';

const corpus: CorpusDoc[] = [
  {
    title: 'ant-design.md',
    originFile: 'docs/ui/ant-design.md',
    text:
      'Ant Design: A massive ecosystem designed primarily for enterprise applications. ' +
      'It includes advanced structural components for data-dense dashboards, such as deep data grids, navigation trees, and complex breadcrumb layouts.',
  },
  {
    title: 'material-ui.md',
    originFile: 'docs/ui/material-ui.md',
    text:
      "Material UI (MUI): The most widely used React library implementing Google's Material Design. " +
      'It offers an exhaustive suite of pre-built components, robust theming, and premium extensions for complex data handling.',
  },
  {
    title: 'mantine.md',
    originFile: 'docs/ui/mantine.md',
    text:
      'Mantine: A highly fully-featured library that provides a comprehensive set of hooks and components with great out-of-the-box defaults, ' +
      'handling everything from local storage to complex form management.',
  },
  {
    title: 'radix-ui.md',
    originFile: 'docs/ui/radix-ui.md',
    text:
      'Radix UI: Provides unstyled, accessible UI primitives. ' +
      'You handle the CSS styling layer, while Radix manages the complex state logic, keyboard navigation, and strict WAI-ARIA compliance.',
  },
  {
    title: 'shadcn-ui.md',
    originFile: 'docs/ui/shadcn-ui.md',
    text:
      'shadcn/ui: A collection of beautifully designed components built on Radix UI and Tailwind CSS. ' +
      'Rather than installing an NPM package, you copy the component code directly into your repository, giving you total ownership and avoiding vendor lock-in.',
  },
  {
    title: 'headless-ui.md',
    originFile: 'docs/ui/headless-ui.md',
    text:
      'Headless UI: Built by the Tailwind Labs team, offering fully unstyled components that integrate perfectly with utility-first CSS workflows.',
  },
  {
    title: 'ink.md',
    originFile: 'docs/ui/ink.md',
    text:
      'Ink: Brings React to the terminal. It allows for building interactive, robust CLI tools using standard React components and Flexbox, ' +
      'which is highly effective for standardizing developer tooling and orchestration scripts.',
  },
  {
    title: 'chakra-ui.md',
    originFile: 'docs/ui/chakra-ui.md',
    text:
      'Chakra UI: Focuses heavily on developer ergonomics, utilizing a modular, prop-based styling system that allows for rapid UI construction ' +
      'without having to write separate CSS files.',
  },
];

export const uiEcosystemDataset: BenchmarkDataset = {
  name: 'react-ui-ecosystem-v1',
  provenance: { curatedBy: 'human-sme', generatedBy: 'manual-curation' },
  corpus,
  cases: [
    // ---- common (11 — 55%) ----------------------------------------------------
    {
      id: 'common-01',
      input: 'Which library includes deep data grids and navigation trees for data-dense dashboards?',
      expectedAnswer:
        'It includes advanced structural components for data-dense dashboards, such as deep data grids, navigation trees, and complex breadcrumb layouts.',
      supportingDocs: ['ant-design.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-02',
      input: "Which React library implements Google's Material Design?",
      expectedAnswer: "Material UI (MUI): The most widely used React library implementing Google's Material Design.",
      supportingDocs: ['material-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-03',
      input: 'Which library handles everything from local storage to complex form management?',
      expectedAnswer:
        'Mantine: A highly fully-featured library that provides a comprehensive set of hooks and components with great out-of-the-box defaults, handling everything from local storage to complex form management.',
      supportingDocs: ['mantine.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-04',
      input: 'Which library provides unstyled accessible UI primitives while you handle the CSS styling layer?',
      expectedAnswer:
        'Radix UI: Provides unstyled, accessible UI primitives. You handle the CSS styling layer, while Radix manages the complex state logic, keyboard navigation, and strict WAI-ARIA compliance.',
      supportingDocs: ['radix-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-05',
      input: 'How does shadcn/ui give you total ownership and avoid vendor lock-in?',
      expectedAnswer:
        'Rather than installing an NPM package, you copy the component code directly into your repository, giving you total ownership and avoiding vendor lock-in.',
      supportingDocs: ['shadcn-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-06',
      input: 'Which team builds Headless UI and what CSS workflows does it integrate with?',
      expectedAnswer:
        'Headless UI: Built by the Tailwind Labs team, offering fully unstyled components that integrate perfectly with utility-first CSS workflows.',
      supportingDocs: ['headless-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-07',
      input: 'Which library brings React to the terminal for interactive CLI tools?',
      expectedAnswer:
        'Ink: Brings React to the terminal. It allows for building interactive, robust CLI tools using standard React components and Flexbox, which is highly effective for standardizing developer tooling and orchestration scripts.',
      supportingDocs: ['ink.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-08',
      input: 'What styling system does Chakra UI use for rapid UI construction?',
      expectedAnswer:
        'Chakra UI: Focuses heavily on developer ergonomics, utilizing a modular, prop-based styling system that allows for rapid UI construction without having to write separate CSS files.',
      supportingDocs: ['chakra-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-09',
      input: 'What does Radix manage besides the complex state logic?',
      expectedAnswer:
        'You handle the CSS styling layer, while Radix manages the complex state logic, keyboard navigation, and strict WAI-ARIA compliance.',
      supportingDocs: ['radix-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-10',
      input: 'What premium extensions does Material UI offer for complex data handling?',
      expectedAnswer:
        'It offers an exhaustive suite of pre-built components, robust theming, and premium extensions for complex data handling.',
      supportingDocs: ['material-ui.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-11',
      input: 'Which layout primitive does Ink use to build robust CLI tools?',
      expectedAnswer:
        'It allows for building interactive, robust CLI tools using standard React components and Flexbox, which is highly effective for standardizing developer tooling and orchestration scripts.',
      supportingDocs: ['ink.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },

    // ---- distractor (5 — 25%): sibling libraries are the lures ------------------
    {
      id: 'distractor-01',
      input: 'Is Ant Design or Material UI designed primarily for enterprise dashboards?',
      expectedAnswer:
        'Ant Design: A massive ecosystem designed primarily for enterprise applications. It includes advanced structural components for data-dense dashboards, such as deep data grids, navigation trees, and complex breadcrumb layouts.',
      supportingDocs: ['ant-design.md'],
      metadata: {
        // comparative phrasing names both libraries → extractive answers
        // legitimately quote both docs; correctness floor is 'free'
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'free',
        tags: ['lure:material-ui.md'],
      },
    },
    {
      id: 'distractor-02',
      input: 'Does Radix UI ship styled components or unstyled accessible primitives?',
      expectedAnswer: 'Radix UI: Provides unstyled, accessible UI primitives.',
      supportingDocs: ['radix-ui.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:headless-ui.md'],
      },
    },
    {
      id: 'distractor-03',
      input: 'Is shadcn/ui built on Tailwind CSS, and is it installed from NPM?',
      expectedAnswer:
        'shadcn/ui: A collection of beautifully designed components built on Radix UI and Tailwind CSS. Rather than installing an NPM package, you copy the component code directly into your repository, giving you total ownership and avoiding vendor lock-in.',
      supportingDocs: ['shadcn-ui.md'],
      metadata: {
        // names two ecosystems (Tailwind + NPM) → comparative answer; 'free'
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'free',
        tags: ['lure:headless-ui.md'],
      },
    },
    {
      id: 'distractor-04',
      input: 'Which library focuses on developer ergonomics with prop-based styling instead of separate CSS files?',
      expectedAnswer:
        'Chakra UI: Focuses heavily on developer ergonomics, utilizing a modular, prop-based styling system that allows for rapid UI construction without having to write separate CSS files.',
      supportingDocs: ['chakra-ui.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:radix-ui.md'],
      },
    },
    {
      id: 'distractor-05',
      input: 'Does Mantine or Material UI handle local storage and complex form management?',
      expectedAnswer:
        'Mantine: A highly fully-featured library that provides a comprehensive set of hooks and components with great out-of-the-box defaults, handling everything from local storage to complex form management.',
      supportingDocs: ['mantine.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:material-ui.md'],
      },
    },

    // ---- multi-hop (2 — 10%) -----------------------------------------------------
    {
      id: 'multihop-01',
      input: 'What does shadcn/ui copy into your repository, and what does Radix manage underneath it?',
      expectedAnswer:
        'Rather than installing an NPM package, you copy the component code directly into your repository, giving you total ownership and avoiding vendor lock-in. You handle the CSS styling layer, while Radix manages the complex state logic, keyboard navigation, and strict WAI-ARIA compliance.',
      supportingDocs: ['shadcn-ui.md', 'radix-ui.md'],
      metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
    },
    {
      id: 'multihop-02',
      input: "Which library targets the terminal with Flexbox, and which implements Google's Material Design?",
      expectedAnswer:
        "Ink: Brings React to the terminal. It allows for building interactive, robust CLI tools using standard React components and Flexbox. Material UI (MUI): The most widely used React library implementing Google's Material Design.",
      supportingDocs: ['ink.md', 'material-ui.md'],
      metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
    },

    // ---- no-answer (2 — 10%) -------------------------------------------------------
    {
      id: 'noanswer-01',
      input: 'What is the annual licensing fee for paid support contracts?',
      expectedAnswer: '',
      supportingDocs: [],
      metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'strict' },
    },
    {
      id: 'noanswer-02',
      input: 'Which minimum Vue version does each of these libraries require?',
      expectedAnswer: '',
      supportingDocs: [],
      metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'strict' },
    },
  ],
};
