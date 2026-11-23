export const lexerInput = '12345 + 67890 + 42\n'.repeat(256);
export const sourceInput = 'let balance_12 = 42;\nprint balance_12;\n'.repeat(128);

export const workloads = [
    { name: 'expression-64', input: Array(64).fill('1+2*3').join('+'), expected: 448 },
    { name: 'expression-512', input: Array(512).fill('1+2*3').join('+'), expected: 3584 },
    { name: 'nested-128', input: `${'('.repeat(128)}1${')'.repeat(128)}`, expected: 1 },
    { name: 'nested-512', input: `${'('.repeat(512)}1${')'.repeat(512)}`, expected: 1 }
];

const sourceWorkload = count => {
    const expected = Array.from({ length: count }, (_, index) => [`setting_${index}`, index - 17]);
    return {
        name: `settings-${count}`,
        input: expected.map(([name, value], index) =>
            `# setting ${index}\n${name} = ${value};\n`).join(''),
        expected
    };
};
export const sourceWorkloads = [sourceWorkload(4), sourceWorkload(128)];
