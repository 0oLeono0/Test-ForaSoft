import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const CLIENT_SOURCES = ['client/src/**/*.{js,jsx}'];

export default [
  {
    ignores: ['**/node_modules/', '**/dist/', 'coverage/', 'playwright-report/', 'test-results/'],
  },

  js.configs.recommended,

  // Защита от XSS (FR-39, TDD §10.3): текст выводится только через {text} в JSX.
  {
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Выводите текст через {text} в JSX или textContent.' },
        { property: 'outerHTML', message: 'Выводите текст через {text} в JSX или textContent.' },
      ],
    },
  },

  // shared работает и в Node, и в браузере: только общие глобальные переменные.
  {
    files: ['shared/**/*.js'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },

  {
    files: ['server/**/*.js', 'scripts/**/*.js', '*.config.js', 'client/*.config.js'],
    languageOptions: { globals: globals.node },
  },

  // Атомарность лимита участников (FR-7, TDD §4.2.2): код комнат синхронный, чтобы между
  // проверкой лимита и вставкой участника не было await. Тесты под правило не попадают.
  {
    files: ['server/src/rooms/**/*.js'],
    ignores: ['**/*.test.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AwaitExpression',
          message: 'RoomManager и Room синхронны: await разрывает атомарность join (TDD §4.2.2).',
        },
        {
          selector: 'ForOfStatement[await=true]',
          message:
            'RoomManager и Room синхронны: for await разрывает атомарность join (TDD §4.2.2).',
        },
        {
          selector: ':function[async=true]',
          message: 'RoomManager и Room синхронны: async-функции запрещены (TDD §4.2.2).',
        },
      ],
    },
  },

  { files: CLIENT_SOURCES, ...react.configs.flat.recommended },
  { files: CLIENT_SOURCES, ...react.configs.flat['jsx-runtime'] },
  { files: CLIENT_SOURCES, ...reactHooks.configs.flat.recommended },
  {
    files: CLIENT_SOURCES,
    languageOptions: { globals: globals.browser },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/no-danger': 'error',
      // Формы props описываются JSDoc (TDD §4), пакет prop-types не используется.
      'react/prop-types': 'off',
    },
  },
];
