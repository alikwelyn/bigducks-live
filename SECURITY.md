# Segurança

Não publique vulnerabilidades, tokens, IPs pessoais ou logs completos em uma issue.

Envie um relato privado pela opção **Report a vulnerability** na aba Security do repositório. Inclua a versão do BIG DUCKS, versão do Windows e do Discord, passos mínimos para reproduzir e apenas o trecho de log necessário, removendo endereços pessoais.

Releases oficiais são publicadas exclusivamente em `alikwelyn/bigducks-live`. O atualizador rejeita manifesto sem assinatura Ed25519 válida, asset com nome inesperado, downgrade, tamanho fora do limite e SHA-256 divergente.

O projeto usa proxies públicos não confiáveis. Isso não transforma o proxy em uma parte confiável: o desenho depende do TLS do Discord e limita o proxy ao gateway.
