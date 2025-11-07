import winston from 'winston';
import { KafkaTransport } from './kafka-transport';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
    
    new KafkaTransport({
      brokers: ['localhost:9092'],
      clientId: 'my-app-logger',
      topic: 'application-logs',
      keyField: 'userId',
      
      messageFormatter: (info) => ({
        ...info,
        timestamp: info.timestamp,
        level: info.level,
        message: info.message,
        service: 'my-service',
        environment: process.env.NODE_ENV || 'development',
      }),
      
      producerConfig: {
        allowAutoTopicCreation: true,
        transactionTimeout: 30000,
      },
    }),
  ],
});

interface LogMetadata {
  userId?: string;
  action?: string;
  error?: string;
  memoryUsage?: string;
}

logger.info('Application started', { userId: '12345', action: 'startup' } as LogMetadata);
logger.error('Database connection failed', { error: 'ECONNREFUSED', userId: '12345' } as LogMetadata);
logger.warn('High memory usage detected', { memoryUsage: '85%' } as LogMetadata);

const kafkaTransport = logger.transports.find(
  (t) => t instanceof KafkaTransport
) as KafkaTransport | undefined;

if (kafkaTransport) {
  kafkaTransport.on('connected', () => {
    console.log('Kafka transport connected');
  });

  kafkaTransport.on('error', (error) => {
    console.error('Kafka transport error:', error);
  });

  kafkaTransport.on('disconnected', () => {
    console.log('Kafka transport disconnected');
  });
}

const shutdown = async (): Promise<void> => {
  console.log('Shutting down...');
  
  const closePromises = logger.transports
    .filter((transport) => typeof (transport as any).close === 'function')
    .map((transport) => (transport as any).close());
  
  await Promise.all(closePromises);
  
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
