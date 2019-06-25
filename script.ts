import { Observable, fromEvent, merge, asapScheduler } from 'rxjs';
import { first, map } from 'rxjs/operators';

import { PathSet, Path, DataSource, JSONGraph, JSONGraphEnvelope } from 'falcor';

// DataSources do a good job of representing the "named" data structures.

type LogEntry = {type: 'set', jsonGraphEnvelope: JSONGraphEnvelope}
              | {type: 'call', functionPath: Path, args?: Array<any>, refSuffixes?: Array<PathSet>, thisPaths?: Array<PathSet>}

// Wraps a Falcor Data Source and stores the set/call requests in a log.
interface IDataSource {
    get(pathSets: Array<PathSet>): falcor.Observable<JSONGraphEnvelope>;
    set(jsonGraphEnvelope: JSONGraphEnvelope): falcor.Observable<JSONGraphEnvelope>;
    call(functionPath: Path, args?: any[], refSuffixes?: PathSet[], thisPaths?: PathSet[]): falcor.Observable<JSONGraphEnvelope>;
}

class DataSourceWrapper implements IDataSource {
    private _log: Array<LogEntry> = [];

    constructor(private readonly ds: DataSource) { }

    get currentIndex(): number { return this._log.length; }

    get log(): Array<LogEntry> { return this._log; } // TODO: Maybe make a copy...

    get(pathSets: Array<PathSet>): falcor.Observable<JSONGraphEnvelope> {
        return this.ds.get(pathSets);
    }

    set(jsonGraphEnvelope: JSONGraphEnvelope): falcor.Observable<JSONGraphEnvelope> {
        this._log.push({type: 'set', jsonGraphEnvelope: jsonGraphEnvelope});
        return this.ds.set(jsonGraphEnvelope);
    }

    call(functionPath: Path, args?: any[], refSuffixes?: PathSet[], thisPaths?: PathSet[]): falcor.Observable<JSONGraphEnvelope> {
        this._log.push({type: 'call', functionPath: functionPath, args: args, refSuffixes: refSuffixes, thisPaths: thisPaths});
        return this.ds.call(functionPath, args, refSuffixes, thisPaths);
    }
}

type User = {id: number, role: string, extraData: any} // This is a placeholder for what would be some opaque type.

type ScriptLogEntry<R> = {type: 'interactCall', user: User, template: string, data: any}
                       | {type: 'interactResponse', logIndex: number, response: R}
                       | {type: 'allocUser', role: string, extraData: any};

abstract class InteractionScript<I, R, A> { // TODO: Probably want I, R, and A to be JSONGraphs.
    private userCount: number = 0;
    private _log: Array<ScriptLogEntry<R>> = [];

    // TODO: Add logIndex to requester.
    constructor(private readonly requester: (u: User, t: string, d: any) => Promise<R>) { }

    get log(): Array<ScriptLogEntry<R>> { return this._log; } // TODO: Maybe make a copy...

    get logIndex(): number { return this._log.length; }

    abstract start(initData: I): Promise<A>;

    async interact(user: User, template: string, data: any): Promise<R> {
        const logIndex = this._log.length;
        this._log.push({type: 'interactCall', user: user, template: template, data: data});
        const r = await this.requester(user, template, data);
        this._log.push({type: 'interactResponse', logIndex: logIndex, response: r});
        return r;
    }

    async allocUser(role: string, extraData?: any): Promise<User> {
        this._log.push({type: 'allocUser', role: role, extraData: extraData});
        return {id: this.userCount++, role: role, extraData: extraData};
    }
}

type Question = string;

type Answer = string;

type FEResponse = {type: 'Questions', subquestions: Array<Question>}
                | {type: 'ChoseHonest', choice: Boolean}
                | {type: 'Answer', answer: Answer};

class FE extends InteractionScript<Question, FEResponse, Answer> {
    constructor(requester: (u: User, t: string, d: any) => Promise<FEResponse>) {
        super(requester);
    }

    async start(qTop: string): Promise<Answer> {
        const ho = await this.allocUser('honestOracleRole');
        const ha = await this.interact(ho, 'honest_template', {question: qTop});
        if(ha.type !== 'Answer') throw ha;
        const mo = await this.allocUser('maliciousOracleRole');
        const ma = await this.interact(mo, 'malicious_template', {question: qTop, honest_answer: ha.answer});
        if(ma.type !== 'Answer') throw ma;
        return await this.adjudicate(qTop, [], ha.answer, ma.answer, ho, mo);
    }

    private async adjudicate(q: Question, oldQs: Array<[Question, Answer]>, ha: Answer, ma: Answer, ho: User, mo: User): Promise<Answer> {
        const u = await this.allocUser('adjudicatorRole');
        const r = await this.interact(u, 'adjudicate_template', {question: q, honest_answer: ha, malicious_answer: ma, subquestions: oldQs});
        if(r.type === 'Questions') {
            const subQs = r.subquestions;
            const subAnswers = await Promise.all(subQs.map(async subQ => {
                const subHA = await this.interact(ho, 'honest_template', {question: subQ});
                if(subHA.type !== 'Answer') throw subHA;
                const subMA = await this.interact(mo, 'malicious_template', {question: subQ, honest_answer: subHA.answer});
                if(subMA.type !== 'Answer') throw subMA;
                return this.adjudicate(subQ, [], subHA.answer, subMA.answer, ho, mo);
            }));
            const newQs = oldQs.concat(subQs.map((q, i) => [q, subAnswers[i]]));
            return this.adjudicate(q, newQs, ha, ma, ho, mo);
        } else if(r.type === 'ChoseHonest') {
            return r.choice ? ha : ma;
        } else {
            throw r;
        }
    }
}

const roleLabel = document.getElementById('roleLabel') as HTMLSpanElement;
const questionLabel = document.getElementById('questionLabel') as HTMLSpanElement;
const extraLabel = document.getElementById('extraLabel') as HTMLSpanElement;
const inputTxt = document.getElementById('inputTxt') as HTMLInputElement;
const expertDiv = document.getElementById('expertDiv') as HTMLDivElement;
const answerBtn = document.getElementById('answerBtn') as HTMLInputElement;
const judgeDiv = document.getElementById('judgeDiv') as HTMLDivElement;
const askBtn = document.getElementById('askBtn') as HTMLInputElement;
const firstAnswerLabel = document.getElementById('firstAnswerLabel') as HTMLSpanElement;
const firstBtn = document.getElementById('firstBtn') as HTMLInputElement;
const secondAnswerLabel = document.getElementById('secondAnswerLabel') as HTMLSpanElement;
const secondBtn = document.getElementById('secondBtn') as HTMLInputElement;

const responseObservable: Observable<FEResponse> = merge(
    fromEvent(answerBtn, 'click').pipe(map((_: Event) => { return {type: 'Answer', answer: inputTxt.value}; })),
    fromEvent(firstBtn, 'click').pipe(map((_: Event) => { return {type: 'ChoseHonest', choice: true}; })),
    fromEvent(secondBtn, 'click').pipe(map((_: Event) => { return {type: 'ChoseHonest', choice: false}; })),
    fromEvent(askBtn, 'click').pipe(map((_: Event) => { return {type: 'Questions', subquestions: [inputTxt.value]}; })),
    asapScheduler) as Observable<FEResponse>; // TODO: Can I get rid of this cast?

// TODO: There's got to be a better way of doing this.
let resolver: ((r: FEResponse) => void) | null = null;

responseObservable.subscribe(r => {
    console.log({subscribe: r});
    const res = resolver;
    if(res !== null) {
        res(r);
    }
});

const requester = (u: User, t: string, d: any) => {
    console.log({user: u, template: t, data: d});
    roleLabel.textContent = u.role;
    inputTxt.value = '';
    questionLabel.textContent = d.question;
    if(t === 'adjudicate_template') {
        expertDiv.style.display = 'none';
        judgeDiv.style.display = 'block';
        extraLabel.textContent = d.subquestions.map((x: [Question, Answer]) => x[0]+': '+x[1]).join('\n\n');
        firstAnswerLabel.textContent = d.honest_answer;
        secondAnswerLabel.textContent = d.malicious_answer;
    } else {
        expertDiv.style.display = 'block';
        judgeDiv.style.display = 'none';
        extraLabel.textContent = t === 'malicious_template' ? d.honest_answer : '';
        firstAnswerLabel.textContent = '';
        secondAnswerLabel.textContent = '';
    }
    return new Promise<FEResponse>((resolve, reject) => resolver = resolve);
};

new FE(requester).start('What is your question?').then(r => console.log({done: r}));
