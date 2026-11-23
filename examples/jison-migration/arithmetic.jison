%lex
DIGIT [0-9]
%%
\s+                    /* skip whitespace */
{DIGIT}+ {
    return 'NUMBER';
}
"+" {
    return '+';
}
/lex

%token NUMBER
%left '+'
%start expression
%%
expression
    : expression '+' expression { $$ = Number($1) + Number($3); }
    | NUMBER {
        const result = { value: Number($1) };
        $$ = result.value;
    }
    ;
