# Contribuindo

Contribuições pequenas, testáveis e focadas são bem-vindas.

1. Crie um fork e uma branch curta.
2. Escreva ou ajuste o teste que demonstra o comportamento.
3. Execute `gofmt`, `go test ./...`, `go vet ./...` e `build.ps1` no Windows.
4. Não inclua pools de proxy, logs, binários, dados do Discord ou caminhos pessoais.
5. Explique no pull request o risco, a estratégia de rollback e como o comportamento foi verificado.

Mudanças na injeção, ACL, PAC, atualização ou substituição do executável exigem testes de falha além do caminho feliz. O cliente oficial deve permanecer restaurável byte a byte.
