import { Observable, fromEvent, merge, asapScheduler } from 'rxjs';
import { first, map } from 'rxjs/operators';

import { Model, PathSet, Path, DataSource, JSONGraph, JSONGraphEnvelope } from 'falcor';

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

// The logIndex isn't really meant for the template but to help correlate to the interaction log.
type Requester<R> = (u: User, t: string, logIndex: number, d: any) => Promise<R>;

abstract class InteractionScript<I, R, A> { // TODO: Probably want I, R, and A to be JSONGraphs.
    private userCount: number = 0;
    private _log: Array<ScriptLogEntry<R>> = [];

    constructor(private readonly requester: Requester<R>) { }

    get log(): Array<ScriptLogEntry<R>> { return this._log; } // TODO: Maybe make a copy...

    get logIndex(): number { return this._log.length; }

    abstract start(initData: I): Promise<A>;

    async interact(user: User, template: string, data: any): Promise<R> {
        const logIndex = this._log.length;
        this._log.push({type: 'interactCall', user: user, template: template, data: data});
        const r = await this.requester(user, template, logIndex, data);
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
    readonly dsw: DataSourceWrapper = new DataSourceWrapper(new Model({cache: {}}).asDataSource());
    private readonly model: Model = new Model({source: this.dsw});

    constructor(requester: Requester<FEResponse>) {
        super(requester);
    }

    async start(qTop: string): Promise<Answer> {
        const ho = await this.allocUser('honestOracleRole');
        const ha = await this.interact(ho, 'honest_template', {question: qTop});
        if(ha.type !== 'Answer') throw ha;
        const mo = await this.allocUser('maliciousOracleRole');
        const ma = await this.interact(mo, 'malicious_template', {question: qTop, honest_answer: ha.answer});
        if(ma.type !== 'Answer') throw ma;
        return await this.adjudicate(qTop, 'root', [], ha.answer, ma.answer, ho, mo);
    }

    private async adjudicate(q: Question, wsId: string, oldQs: Array<[Question, Answer]>, ha: Answer, ma: Answer, ho: User, mo: User): Promise<Answer> {
        const u = await this.allocUser('adjudicatorRole');
        const r = await this.interact(u, 'adjudicate_template', {question: q, honest_answer: ha, malicious_answer: ma, subquestions: oldQs});
        await this.model.setValue(wsId+'.question', q);
        await this.model.setValue(wsId+'.honest_answer', ha);
        await this.model.setValue(wsId+'.malicious_answer', ma);
        if(r.type === 'Questions') {
            const subQs = r.subquestions;
            const j = oldQs.length;
            const subAnswers = await Promise.all(subQs.map(async (subQ, i) => {
                const subHA = await this.interact(ho, 'honest_template', {question: subQ});
                if(subHA.type !== 'Answer') throw subHA;
                const subMA = await this.interact(mo, 'malicious_template', {question: subQ, honest_answer: subHA.answer});
                if(subMA.type !== 'Answer') throw subMA;
                return this.adjudicate(subQ, wsId+'.subquestions['+(j+i)+']', [], subHA.answer, subMA.answer, ho, mo);
            }));
            const newQs = oldQs.concat(subQs.map((q, i) => [q, subAnswers[i]]));
            return this.adjudicate(q, wsId, newQs, ha, ma, ho, mo);
        } else if(r.type === 'ChoseHonest') {
            const answer = r.choice ? ha : ma;
            await this.model.setValue(wsId+'.answer', answer);
            return answer;
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

// TODO: There's got to be a better way of doing this, than this nextEvent stuff.
let resolver: ((r: FEResponse) => void) | null = null;

responseObservable.subscribe(r => {
    const res = resolver;
    if(res !== null) {
        res(r);
    }
});

const nextEvent: () => Promise<FEResponse> = () => {
    return new Promise<FEResponse>((resolve, reject) => resolver = resolve);
};

const requester: Requester<FEResponse> = (u: User, t: string, logIndex: number, d: any) => {
    console.log({user: u, template: t, logIndex: logIndex, data: d});
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
    return nextEvent();
};

function makeReplayRequester<R>(log: Array<ScriptLogEntry<R>>, requester: Requester<R>): Requester<R> {
    let i = 0;
    return (u: User, t: string, logIndex: number, d: any) => {
        while(i < log.length) {
            const entry = log[i++];
            if(entry.type === 'interactResponse') { // TODO: Be smarter about matching the response to the request. This will be necessary to handle concurrency.
                return Promise.resolve(entry.response);
            }
        }
        return requester(u, t, logIndex, d);
    };
}

export const script = new FE(requester); // export is temporary.
script.start('What is your question?').then(r => {
    console.log({done: r})
    console.log(script.log);
    const replayRequester = makeReplayRequester<FEResponse>(script.log.slice(0, 13), requester);
    const replayScript = new FE(replayRequester);
    replayScript.start('What is your question?').then(r2 => {
        console.log({replayDone: r2})
        console.log(replayScript.log);
    });
});
