import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest без `globals: true` не подключает автоочистку React Testing Library.
afterEach(cleanup);
