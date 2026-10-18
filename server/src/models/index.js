// Barrel file: importing this module registers every Mongoose model
// (which makes Mongoose build their indexes on boot) and gives callers
// a single import path.
export { User } from './User.js';
export { Conversation } from './Conversation.js';
export { Message } from './Message.js';
