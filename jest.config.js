module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  // Default testMatch would treat __tests__/helpers/* as test suites.
  testMatch: ['<rootDir>/__tests__/**/*.test.js'],

  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/__mocks__/styleMock.js',
  },

  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },

  // @noble/* and @scure/* ship ESM only, and nostr-tools' CJS build requires them,
  // so they have to go through babel rather than being skipped as node_modules.
  transformIgnorePatterns: ['/node_modules/(?!.*(@noble|@scure))'],

  collectCoverage: true,
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: ['/node_modules/', '/__tests__/'],
}
