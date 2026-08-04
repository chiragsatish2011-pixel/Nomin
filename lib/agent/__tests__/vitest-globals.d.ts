// Local type declarations for vitest globals
/// <reference types="vitest" />

interface ViMock<T extends (...args: any[]) => any> {
  mockResolvedValue: (value: any) => ViMock<T>;
  mockRejectedValue: (value: any) => ViMock<T>;
  mockImplementation: (fn: T) => ViMock<T>;
}

interface Vi {
  fn: <T extends (...args: any[]) => any>(implementation?: T) => T & ViMock<T>;
  mock: (path: string, factory: () => any) => void;
  clearAllMocks: () => void;
  Mock: new <T extends (...args: any[]) => any>() => ViMock<T>;
}

declare const vi: Vi;