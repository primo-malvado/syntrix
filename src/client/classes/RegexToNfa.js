import Parser from './Parser.js';
import Lexer from './Lexer.js';


function _parseTree (regexStructure) {
    const config = {
        lastId: 0,
        getNextId () {
            const n = this.lastId++;
            return `${n}`;
        },
        structure: {
            end: [],
            start: [],
            table: []

        }
    };

    const startId = config.getNextId(config);
    const endId = config.getNextId(config);

    config.structure.start.push(startId);
    config.structure.end.push(endId);

    _parseNode(config, regexStructure, startId, endId);
    return config.structure;
}

function _parseNode (config, rule, previous, next) {
    let newPrev,
        newNext,
        i;

    switch (rule.tokenType) {

    case 'char':
        config.structure.table.push({
            from: previous,
            to: next,
            _ft_: rule.rules[0],
            _tt_: rule.rules[0]

        });

        break;

    case 'range':
        if (rule.rules[0].content > rule.rules[1].content) {
            throw new SyntaxError('Regular expression character range must be ordered');
        }
        if (rule.rules[0].content <= 'ε' && rule.rules[1].content >= 'ε') {
            throw new SyntaxError('Regular expression character ranges cannot contain epsilon');
        }

        config.structure.table.push({
            from: previous,
            to: next,
            _ft_: rule.rules[0].content,
            _tt_: rule.rules[1].content

        });

        break;

    case 'star':
        newPrev = config.getNextId(config);
        newNext = config.getNextId(config);

        config.structure.table.push({
            from: previous,
            to: next,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: newNext,
            to: newPrev,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: previous,
            to: newPrev,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: newNext,
            to: next,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        _parseNode(config, rule.rules[0], newPrev, newNext);

        break;

    case 'optional':

        newPrev = config.getNextId(config);

        newNext = config.getNextId(config);

        config.structure.table.push({
            from: newPrev,
            to: newNext,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: previous,
            to: newPrev,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: newNext,
            to: next,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        _parseNode(config, rule.rules[0], newPrev, newNext);

        break;

    case 'plus':
        newPrev = config.getNextId(config);

        newNext = config.getNextId(config);

        config.structure.table.push({
            from: newNext,
            to: newPrev,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: previous,
            to: newPrev,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        config.structure.table.push({
            from: newNext,
            to: next,
            _ft_: 'ε',
            _tt_: 'ε'

        });

        _parseNode(config, rule.rules[0], newPrev, newNext);

        break;

    case 'concat':

        for (i = 0; i < rule.rules.length - 1; i++) {
            newNext = config.getNextId(config);

            _parseNode(config, rule.rules[i], previous, newNext);

            previous = newNext;
        }

        _parseNode(config, rule.rules[i], previous, next);

        break;

    case 'or':

        for (i = 0; i < rule.rules.length; i++) {
            _parseNode(config, rule.rules[i], previous, next);
        }

        break;

    default:

        throw new SyntaxError(`Unsupported regular expression node: ${rule.tokenType}`);

    }
}


import { config as regexConfig} from './regexConfig.js';


function RegexToNfa (inputText) {
    if (typeof inputText !== 'string') throw new TypeError('Regular expression must be a string');
    if (inputText.includes('ε')) throw new SyntaxError('The epsilon character is reserved');
    const lexer = new Lexer(regexConfig.lexerTable);
    const parser = new Parser(lexer, regexConfig.parserTable);

    const a = parser.parse(inputText);

    const sm = _parseTree(a);
    return sm;
 
}

export default RegexToNfa;
