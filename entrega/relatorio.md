# Relatório Técnico — Mini E-commerce Distribuído

---

## 1. Comunicação entre Serviços

### Estratégia Implementada

Todos os serviços se comunicam exclusivamente via **HTTP/REST síncrono**. O API Gateway atua como proxy reverso, interceptando cada requisição do cliente, verificando a disponibilidade do serviço-alvo no registry interno e repassando a chamada com os headers originais preservados (`Authorization`, `Content-Type`) mais o marcador interno `X-Gateway-Request: true`.

A única comunicação serviço-a-serviço fora do gateway ocorre no fluxo de criação de pedidos: o serviço Orders consulta diretamente o serviço Products via `GET /products/:id` antes de persistir o pedido, validando a existência do produto sem passar pelo gateway. Adicionalmente, a primária de Products envia `POST /internal/sync` à réplica no mesmo fluxo de escrita, protegido por `X-Internal-Key`.

### Trade-offs: REST vs Filas de Mensagem

| Critério | REST síncrono (implementado) | Fila de mensagens (ex.: RabbitMQ, Kafka) |
|---|---|---|
| Acoplamento | Forte — Orders depende da disponibilidade de Products | Fraco — producer publica e prossegue |
| Latência percebida | Imediata — resposta inclui validação | Assíncrona — cliente recebe ACK antes da consistência final |
| Tolerância a falhas | Se Products está down, Orders retorna 502 | Orders persiste mesmo com Products temporariamente indisponível |
| Rastreabilidade | Trivial — um request-id por chamada | Requer correlation IDs e tracing distribuído |
| Complexidade operacional | Baixa | Alta — broker, dead-letter queues, consumers |

Para um catálogo de produtos cujos dados mudam raramente e onde a validação de existência é crítica para a integridade do pedido, o modelo REST síncrono é adequado. Em sistemas de alto volume com leituras de catálogo frequentes, um cache local no serviço Orders (TTL curto) eliminaria a dependência em tempo de escrita sem introduzir a complexidade de um broker.

---

## 2. Consistência na Replicação de Produtos

### Estratégia Implementada: Consistência Forte com Degradação Graceful

A escrita segue o modelo **primary-backup síncrono**:

1. Cliente envia `POST /products` ao gateway, que roteia para a **primária** (5002).
2. A primária persiste localmente no `products.json`.
3. **Antes de responder ao cliente**, a primária faz `POST /internal/sync` à réplica (5012) com timeout de 3 segundos.
4. Se a réplica confirmar, a resposta é `201 Created` sem avisos.
5. Se a réplica falhar ou expirar o timeout, a primária responde `201 Created` com o header `X-Replica-Warning: replica sync failed` — registrando a inconsistência sem bloquear o cliente.

### Justificativa da Escolha

Produtos representam o catálogo de itens vendáveis. Permitir que um pedido seja criado para um produto cujos dados ainda não chegaram à réplica (inconsistência de leitura) é aceitável, pois o pedido ainda valida contra a primária. O risco real seria vender um item que **não existe** — por isso a escrita deve ser atômica na primária antes de qualquer confirmação ao cliente.

A degradação graceful (fallback para consistência eventual) evita que uma falha temporária da réplica bloqueie a criação de produtos. Sistemas como o DynamoDB chamam esse modelo de *"strong consistency reads + eventual replication"*: garantia de leitura consistente quando via primária, com propagação eventual às demais réplicas.

**Limitação conhecida:** produtos criados durante a indisponibilidade da réplica não são reenviados automaticamente após a recuperação. Um mecanismo de **replication log com replay** ou uma fila de sincronização pendente seria necessário para garantir convergência eventual.

---

## 3. Falha do Serviço de Pedidos

### Comportamento do Sistema

O heartbeat do gateway verifica `/health` de cada serviço a cada 5 segundos com timeout de 2 segundos. Após **2 falhas consecutivas**, o serviço é marcado `"down"` no registry. A partir desse momento:

- Requisições para `/orders/*` retornam imediatamente `503 Service Unavailable` sem tentativa de conexão.
- Os serviços Users e Products continuam **100% operacionais** — não há dependência entre eles e o serviço de pedidos em tempo de leitura ou escrita.
- O log do gateway registra `[FAILURE] orders caiu em <timestamp>`, permitindo alertas baseados em stdout.

### Risco de Perda de Dados em Trânsito

Pedidos que chegam ao serviço exatamente no instante da falha — após a extração do corpo da requisição mas antes da persistência em disco — são perdidos silenciosamente. O cliente recebe um erro de rede ou timeout, mas sem garantia de que o pedido não foi parcialmente processado.

**Mitigações para produção:**

- **Idempotência por chave de cliente:** o cliente gera um `idempotency-key` UUID e o envia no header. O serviço rejeita duplicatas com `409 Conflict`, permitindo retentativas seguras.
- **Write-ahead log (WAL):** a requisição é gravada em log antes do processamento; um processo de recovery reaplica entradas não confirmadas após reinicialização.
- **Fila durável:** o gateway publica o pedido em uma fila persistente (RabbitMQ com `durable: true`); o serviço consome e confirma (`ack`) somente após persistência bem-sucedida.

---

## 4. Autenticação JWT e Controle de Acesso por Role

### Fluxo Completo

```
[1] POST /users/login → Users Service valida credenciais
        ↓ bcrypt.compare(password, hash)
[2] JWT assinado com JWT_SECRET: { userId, email, role, exp: +2h }
        ↓ token retornado ao cliente
[3] Cliente inclui: Authorization: Bearer <token>
        ↓ Gateway repassa header intacto (proxyReq.setHeader)
[4] Serviço downstream chama verifyToken(req, res, next)
        ↓ jwt.verify(token, JWT_SECRET) → payload em req.user
[5] Middleware requireAdmin: if (req.user.role !== "admin") → 403
```

### Por que um usuário comum não pode criar produtos

O JWT carrega `role: "user"` no payload, assinado com `JWT_SECRET`. O middleware `requireAdmin` no serviço Products verifica `req.user.role !== "admin"` e retorna `403 Forbidden` **antes** de qualquer acesso ao corpo da requisição. Mesmo que o cliente forje o payload do token (alterando `role`), a assinatura HMAC-SHA256 deixa de bater com o `JWT_SECRET` do servidor, e `jwt.verify` lança `JsonWebTokenError`, capturado pelo `verifyToken` como `401 Unauthorized`.

O segredo nunca trafega entre serviços — cada serviço valida independentemente o token com a mesma variável de ambiente `JWT_SECRET`. Isso elimina a necessidade de chamadas de validação centralizadas (auth service separado), ao custo de que a revogação de tokens exige lista negra distribuída ou expiração.

---

## 5. Limitações em Relação a um Ambiente de Produção

| Limitação | Impacto | Solução Produção |
|---|---|---|
| **Gateway como SPOF** | Queda do gateway derruba todo o sistema | Deploy multi-instância com load balancer externo (NGINX, ALB) |
| **Sem circuit breaker** | Falhas em cascata se downstream demora | `opossum` ou Resilience4j com half-open state |
| **Sem service discovery** | URLs hardcoded em variáveis de ambiente | Consul, Kubernetes DNS, AWS Service Connect |
| **Consistência eventual sem replay** | Produtos perdidos na réplica durante falha nunca são recuperados | Replication log com processo de reconciliação periódica |
| **Sem retry automático** | Falha transiente = erro permanente para o cliente | Retry exponencial com jitter no gateway |
| **Sem rate limiting** | API exposta a abuso e DDoS | `express-rate-limit` ou API Gateway gerenciado |
| **Segredos em variáveis de ambiente** | Risco de exposição em logs, `ps aux`, dumps de container | AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets |
| **Sem TLS interno** | Tráfego entre serviços em plaintext | mTLS com cert-manager, service mesh (Istio/Linkerd) |
| **Persistência em arquivo JSON** | Sem transações, sem concorrência segura, sem backup | PostgreSQL/MongoDB com replicação nativa |
| **Sem health checks de startup** | Gateway pode rotear antes do serviço estar pronto | `healthcheck` no Docker Compose com `condition: service_healthy` |

### Conclusão

A arquitetura implementada atende os requisitos de um ambiente de demonstração com separação clara de responsabilidades, replicação funcional e detecção de falhas. As limitações elencadas não são defeitos de design, mas simplificações deliberadas — cada uma possui contrapartida conhecida em sistemas de produção, onde os trade-offs de custo operacional, complexidade e resiliência são avaliados conforme a criticidade do domínio.
