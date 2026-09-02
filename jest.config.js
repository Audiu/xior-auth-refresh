module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    clearMocks: true,
    restoreMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**'],
    coverageThreshold: {
        global: {
            branches: 95,
            functions: 95,
            lines: 95,
            statements: 95,
        },
    },
};
