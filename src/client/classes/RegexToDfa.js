import { determinize } from './StateMachineDependency/Determinizer.js';
import RegexToNfa from './RegexToNfa.js';

function RegexToDfa (regex) {
    return determinize(RegexToNfa(regex));
}
export default RegexToDfa;
