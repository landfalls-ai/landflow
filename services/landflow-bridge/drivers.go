package main

// Every broker driver this bridge serves. A blank import runs the driver module's init(), which registers its kind
// with transport.RegisterDriver for LANDFLOW_TRANSPORTS=…,<kind> + LANDFLOW_<KIND>_URL. To add a driver: add its
// module to go.mod (require + replace while the repository is unpublished) and one line here.
//
// Tier 1 (sdks/go/transport/<kind>): kafka, amqp (RabbitMQ), nats (registers nats and jetstream), valkey.
// Tier 2: mqtt (MQTT 5), amqp1 (AMQP 1.0: Artemis, Qpid), pulsar, sqs (LocalStack in tests), pubsub (emulator), servicebus (emulator).
import (
	_ "github.com/landflow/landflow/sdks/go/transport/amqp"
	_ "github.com/landflow/landflow/sdks/go/transport/amqp1"
	_ "github.com/landflow/landflow/sdks/go/transport/kafka"
	_ "github.com/landflow/landflow/sdks/go/transport/mqtt"
	_ "github.com/landflow/landflow/sdks/go/transport/nats"
	_ "github.com/landflow/landflow/sdks/go/transport/pubsub"
	_ "github.com/landflow/landflow/sdks/go/transport/pulsar"
	_ "github.com/landflow/landflow/sdks/go/transport/servicebus"
	_ "github.com/landflow/landflow/sdks/go/transport/sqs"
	_ "github.com/landflow/landflow/sdks/go/transport/valkey"
)
