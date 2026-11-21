declare module 'better-sqlite3' {
	export class Statement {
		run(...params: never[]): unknown;
		get(...params: never[]): unknown;
		all(...params: never[]): unknown[];
	}
	export class Database {
		constructor(path: string, options?: Record<string, unknown>);
		prepare(sql: string): Statement;
		exec(sql: string): unknown;
		close(): unknown;
	}
	const DatabaseCtor: {
		new (path: string, options?: Record<string, unknown>): Database;
		prototype: Database;
	};
	export default DatabaseCtor;
}
