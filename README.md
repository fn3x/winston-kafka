# Winston Kafka Transport (TypeScript)

A fully-typed Apache Kafka transport for Winston logger built with TypeScript.

## Installation

```bash
npm install @fn3x/winston-kafka-transport
pnpm add @fn3x/winston-kafka-transport
yarn add @fn3x/winston-kafka-transport
```

## Features

- **Full TypeScript support** with complete type definitions
- **Automatic connection management** with retry logic
- **Configurable message formatting** with type-safe options
- **Message key support** for Kafka partitioning
- **Error handling** with typed event emitters
- **Graceful shutdown** capability
- **Connection status tracking**

## Quick Start

```typescript
import winston from 'winston';
import { KafkaTransport } from './kafka-transport';

const logger = winston.createLogger({
  transports: [
    new KafkaTransport({
      brokers: ['localhost:9092'],
      topic: 'logs',
    }),
  ],
});

logger.info('Hello Kafka!');
```

## Configuration

### Basic Configuration

```typescript
const logger = winston.createLogger({
  transports: [
    new KafkaTransport({
      brokers: ['localhost:9092'],
      clientId: 'my-app',
      topic: 'application-logs',
    }),
  ],
});
```

### Advanced Configuration

```typescript
import { KafkaTransport, KafkaTransportOptions } from './kafka-transport';
import { CompressionTypes } from 'kafkajs';

const options: KafkaTransportOptions = {
  // Kafka brokers
  brokers: ['broker1:9092', 'broker2:9092'],
  clientId: 'my-app-logger',
  
  // Topic configuration
  topic: 'application-logs',
  
  // Use specific field as message key for partitioning
  keyField: 'userId',
  
  // Custom message formatter with full type safety
  messageFormatter: (info) => ({
    ...info,
    timestamp: info.timestamp || new Date().toISOString(),
    level: info.level,
    message: info.message,
    service: 'my-service',
    environment: process.env.NODE_ENV || 'production',
  }),
  
  // KafkaJS producer configuration
  producerConfig: {
    allowAutoTopicCreation: true,
    idempotent: true,
    compression: CompressionTypes.GZIP,
    maxInFlightRequests: 5,
    transactionTimeout: 30000,
  },
  
  // Full Kafka client configuration (overrides brokers/clientId)
  kafka: {
    clientId: 'winston-logger',
    brokers: ['localhost:9092'],
    ssl: true,
    sasl: {
      mechanism: 'plain',
      username: 'my-username',
      password: 'my-password',
    },
    connectionTimeout: 10000,
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  },

  // Maximum messages to store when disconnected
  maxQueueSize: 500;
};

const logger = winston.createLogger({
  transports: [new KafkaTransport(options)],
});
```

## Type-Safe Logging

```typescript
// Define your log metadata types
interface LogMetadata {
  userId?: string;
  requestId?: string;
  action?: string;
  duration?: number;
  error?: string;
}

// Use typed logging
logger.info('User logged in', { 
  userId: '12345', 
  action: 'login' 
} as LogMetadata);

logger.error('API request failed', {
  requestId: 'req-789',
  error: 'Timeout',
  duration: 5000,
} as LogMetadata);
```

## Configuration Options

```typescript
interface KafkaTransportOptions extends Transport.TransportStreamOptions {
  brokers?: string[];              // Kafka broker addresses
  clientId?: string;               // Kafka client ID
  topic?: string;                  // Target Kafka topic
  keyField?: string;               // Field to use as message key
  messageFormatter?: (info: LogEntry) => any;  // Custom formatter
  producerConfig?: ProducerConfig; // KafkaJS producer config
  kafka?: KafkaConfig;            // Full KafkaJS config
}
```

## Events

The transport emits typed events:

```typescript
const kafkaTransport = new KafkaTransport({ 
  brokers: ['localhost:9092'] 
});

kafkaTransport.on('connected', () => {
  console.log('Connected to Kafka');
});

kafkaTransport.on('disconnected', () => {
  console.log('Disconnected from Kafka');
});

kafkaTransport.on('logged', (info: LogEntry) => {
  console.log('Log sent:', info);
});

kafkaTransport.on('error', (error: Error) => {
  console.error('Kafka error:', error);
});
```

## Methods

```typescript
// Check connection status
const isConnected: boolean = kafkaTransport.isConnected();

// Manually close the connection
await kafkaTransport.close();
```

## Graceful Shutdown

```typescript
const shutdown = async (): Promise<void> => {
  console.log('Shutting down...');
  
  const closePromises = logger.transports
    .filter((t) => typeof (t as any).close === 'function')
    .map((t) => (t as any).close());
  
  await Promise.all(closePromises);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

## Build

```bash
npm run build
```

This compiles TypeScript to JavaScript with type definitions in the `dist/` folder.

## License

MIT
