import { Observable, fromEvent, merge, asapScheduler } from 'rxjs';
import { first, map } from 'rxjs/operators';

import { Model, PathSet, Path, DataSource, JSONGraph, JSONGraphEnvelope } from 'falcor';

// Models do a good job of representing the "named" data structures.

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

type User = {id: number, extraData: any} // This is a placeholder for what would be some opaque type.

type ScriptLogEntry<R> = {type: 'interactCall', user: User, template: string, data: any}
                       | {type: 'interactResponse', logIndex: number, response: R}
                       | {type: 'sendScheduler', async: Boolean, message: any}
                       | {type: 'sendSchedulerResponse', logIndex: number, response: any}
                       | {type: 'allocAgent', extraData: any};

// The logIndex isn't really meant for the template but to help correlate to the interaction log.
type Requester<R> = (u: User, t: string, logIndex: number, d: any) => Promise<R>;

type AgentRequester = (hints: any) => Promise<User>;

abstract class InteractionScript<I, R, A, M, SR> {
    private _log: Array<ScriptLogEntry<R>> = [];

    constructor(private readonly requester: Requester<R>,
                private readonly agentRequester: AgentRequester) { }

    get log(): Array<ScriptLogEntry<R>> { return this._log; } // TODO: Maybe make a copy...

    get logIndex(): number { return this._log.length; }

    abstract start(initData: I): Promise<A>;

    // This presents the scheduler as an event-based system. Could use a channel-like abstraction
    // to allow the scheduler to be written in a cleaner style.
    abstract schedulerBody(message: M | {type: 'AllocUser', hint: any}): Promise<SR | User | void>;

    protected async sendScheduler(message: M): Promise<SR> {
        const logIndex = this._log.length;
        this._log.push({type: 'sendScheduler', async: false, message: message});
        const r = await this.schedulerBody(message);
        this._log.push({type: 'sendSchedulerResponse', logIndex: logIndex, response: r});
        return r as SR;
    }

    protected sendSchedulerAsync(message: M): void {
        this._log.push({type: 'sendScheduler', async: true, message: message});
        this.schedulerBody(message);
    }

    async interact(user: User, template: string, data: any): Promise<R> {
        const logIndex = this._log.length;
        this._log.push({type: 'interactCall', user: user, template: template, data: data});
        const r = await this.requester(user, template, logIndex, data);
        this._log.push({type: 'interactResponse', logIndex: logIndex, response: r});
        return r;
    }

    async allocUser(hint: any): Promise<User> {
        const logIndex = this._log.length;
        const message = {type: 'AllocUser', hint: hint} as {type: 'AllocUser', hint: any};
        this._log.push({type: 'sendScheduler', async: false, message: message});
        const r = await this.schedulerBody(message);
        this._log.push({type: 'sendSchedulerResponse', logIndex: logIndex, response: r});
        return r as User;
    }

    async allocAgent(extraData: any): Promise<User> {
        this._log.push({type: 'allocAgent', extraData: extraData});
        return this.agentRequester(extraData);
    }
}

type Question = string;

type Answer = string;

type FEResponse = {type: 'Questions', subquestions: Array<Question>}
                | {type: 'ChoseHonest', choice: Boolean}
                | {type: 'Answer', answer: Answer};

interface FESchedulerState {
    judges: Array<User>,
    judgeWorkedOn: {[userId: number]: Array<string>}, // Mapping from userId to workspace IDs this judge has worked on.
    judgeAvailable: {[userId: number]: Boolean},
    notifyAvailable: ((user: User) => void) | null
}

type FESchedulerMessage = {type: 'AllocUser', hint: any}
                        | {type: 'UserWorking', user: User}
                        | {type: 'UserWorkedOn', user: User, workspace: string};

class FE extends InteractionScript<Question, FEResponse, Answer, FESchedulerMessage, User> {
    private readonly model: Model = new Model({source: this.dsw});
    private readonly schedulerState: FESchedulerState = { // Could be stored in the Model as well.
        judges: [],
        judgeWorkedOn: {},
        judgeAvailable: {},
        notifyAvailable: null};

    constructor(requester: Requester<FEResponse>,
                agentRequester: AgentRequester,
                readonly dsw: DataSourceWrapper = new DataSourceWrapper(new Model({cache: {}}).asDataSource())) {
        super(requester, agentRequester);
    }

    async schedulerBody(message: FESchedulerMessage): Promise<User | void> {
        console.debug({message: message, state: this.schedulerState});
        switch(message.type) {
            case 'AllocUser':
                switch(message.hint.role) {
                    case 'honestExpertRole':
                    case 'maliciousExpertRole':
                        return await this.allocAgent(message.hint);
                    case 'adjudicatorRole':
                        // TODO: Implement the below policy, or an approximation of it.
                        /*
                        Contamination policy currently used for Mosaic:

                        For judges, in normal scheduling, there must be at least one workspace
                        separating you from whatever you get assigned to. Expert workspaces count here
                        though (maybe they shouldn’t). So this is only relevant in judge-to-judge
                        questioning. (Also, you can get re-assigned to the same workspace if all of the
                        subquestions have been answered.)

                        For judges, if you opt for suboptimal scheduling, even the constraint described
                        in the previous paragraph is dropped.

                        There is, however, a preference ordering in the scheduler that does a
                        lot of contamination work. So assume you’re a judge looking for a workspace
                        assignment. First, workspaces you’ve already been assigned to are given the
                        highest priority, and then, among workspaces you haven’t yet been assigned to,
                        priority is given to those located farthest away from any workspace you’ve
                        previously been assigned to.

                        https://github.com/oughtinc/mosaic/blob/master/server/lib/scheduler/Scheduler.ts#L421 -L460
                        for preference ordering.
                        */

                        try {
                            const judge = await this.allocAgent(message.hint);
                            this.schedulerState.judges.push(judge);
                            return judge;
                        } catch {
                            const wsId = message.hint.workspace;
                            const state = this.schedulerState;
                            const judges: Array<[User, number]> = state.judges.map(judge => {
                                if(!state.judgeAvailable[judge.id]) return [judge, -1/0];
                                const workspaces = state.judgeWorkedOn[judge.id];
                                if(workspaces.includes(wsId)) return [judge, 1/0];
                                // TODO: Calculate distance metric.
                                return [judge, 1];
                            });
                            // Sort largest to smallest.
                            const sortedJudges = judges.sort((a, b) => a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
                            const chosenJudge = sortedJudges[0];
                            if(chosenJudge[1] !== -1/0) return chosenJudge[0];
                            // This is the kind of ugly stuff I wouldn't want to be in the DSL-y parts, i.e. any of the methods
                            // of FE, such as here.
                            return new Promise((resolve, reject) => { // TODO: Make a better abstraction for this chaining of promises.
                                const notify = state.notifyAvailable;
                                if(notify === null) {
                                    state.notifyAvailable = u => { state.notifyAvailable = null; resolve(u); };
                                } else {
                                    // This leads to a LIFO behavior of notifications.
                                    state.notifyAvailable = u => { resolve(u); state.notifyAvailable = notify; };
                                }
                            });
                        }
                }
                break;
            case 'UserWorking':
                this.schedulerState.judgeAvailable[message.user.id] = false;
                break;
            case 'UserWorkedOn':
                const user = message.user;
                const userId = user.id;
                const state = this.schedulerState;
                state.judgeAvailable[userId] = true;
                const workspaces = state.judgeWorkedOn[userId];
                if(workspaces === void(0)) {
                    state.judgeWorkedOn[userId] = [message.workspace];
                } else if(!workspaces.includes(message.workspace)) {
                    workspaces.push(message.workspace);
                }
                const notify = state.notifyAvailable;
                if(notify !== null) notify(user);
        }
    }

    async start(qTop: string): Promise<Answer> {
        const ho = await this.allocUser({role: 'honestExpertRole'});
        const ha = await this.interact(ho, 'honest_template', {question: qTop});
        if(ha.type !== 'Answer') throw ha;
        const mo = await this.allocUser({role: 'maliciousExpertRole'});
        const ma = await this.interact(mo, 'malicious_template', {question: qTop, honest_answer: ha.answer});
        if(ma.type !== 'Answer') throw ma;
        return await this.adjudicate(qTop, 'root', [], ha.answer, ma.answer, ho, mo);
    }

    private async adjudicate(q: Question, wsId: string, oldQs: Array<[Question, Answer]>, ha: Answer, ma: Answer, ho: User, mo: User): Promise<Answer> {
        const u = await this.allocUser({role: 'adjudicatorRole', workspace: wsId});
        this.sendSchedulerAsync({type: 'UserWorking', user: u});
        const r = await this.interact(u, 'adjudicate_template', {question: q, honest_answer: ha, malicious_answer: ma, subquestions: oldQs});
        this.sendSchedulerAsync({type: 'UserWorkedOn', user: u, workspace: wsId});
        await this.model.setValue(wsId+'.userId', u.id);
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

const elements = [1,2,3,4].map(i => {
    const screenDiv = document.getElementById('screen'+i) as HTMLDivElement;
    const roleLabel = document.getElementById('roleLabel'+i) as HTMLSpanElement;
    const questionLabel = document.getElementById('questionLabel'+i) as HTMLSpanElement;
    const extraLabel = document.getElementById('extraLabel'+i) as HTMLSpanElement;
    const inputTxt = document.getElementById('inputTxt'+i) as HTMLInputElement;
    const expertDiv = document.getElementById('expertDiv'+i) as HTMLDivElement;
    const answerBtn = document.getElementById('answerBtn'+i) as HTMLInputElement;
    const judgeDiv = document.getElementById('judgeDiv'+i) as HTMLDivElement;
    const askBtn = document.getElementById('askBtn'+i) as HTMLInputElement;
    const firstAnswerLabel = document.getElementById('firstAnswerLabel'+i) as HTMLSpanElement;
    const firstBtn = document.getElementById('firstBtn'+i) as HTMLInputElement;
    const secondAnswerLabel = document.getElementById('secondAnswerLabel'+i) as HTMLSpanElement;
    const secondBtn = document.getElementById('secondBtn'+i) as HTMLInputElement;
    return {screenDiv: screenDiv
           ,roleLabel: roleLabel
           ,questionLabel: questionLabel
           ,extraLabel: extraLabel
           ,inputTxt: inputTxt
           ,expertDiv: expertDiv
           ,answerBtn: answerBtn
           ,judgeDiv: judgeDiv
           ,askBtn: askBtn
           ,firstAnswerLabel: firstAnswerLabel
           ,firstBtn: firstBtn
           ,secondAnswerLabel: secondAnswerLabel
           ,secondBtn: secondBtn};
});

const responseObservable: Observable<[number, FEResponse]> = merge(
    merge(fromEvent(elements[0].answerBtn, 'click').pipe(map((_: Event) => [0, {type: 'Answer', answer: elements[0].inputTxt.value}])),
          fromEvent(elements[0].firstBtn, 'click').pipe(map((_: Event) => [0, {type: 'ChoseHonest', choice: true}])),
          fromEvent(elements[0].secondBtn, 'click').pipe(map((_: Event) => [0, {type: 'ChoseHonest', choice: false}])),
          fromEvent(elements[0].askBtn, 'click').pipe(map((_: Event) => [0, {type: 'Questions', subquestions: elements[0].inputTxt.value.split(';')}])),
          asapScheduler),
    merge(fromEvent(elements[1].answerBtn, 'click').pipe(map((_: Event) => [1, {type: 'Answer', answer: elements[1].inputTxt.value}])),
          fromEvent(elements[1].firstBtn, 'click').pipe(map((_: Event) => [1, {type: 'ChoseHonest', choice: true}])),
          fromEvent(elements[1].secondBtn, 'click').pipe(map((_: Event) => [1, {type: 'ChoseHonest', choice: false}])),
          fromEvent(elements[1].askBtn, 'click').pipe(map((_: Event) => [1, {type: 'Questions', subquestions: elements[1].inputTxt.value.split(';')}])),
          asapScheduler),
    merge(fromEvent(elements[2].answerBtn, 'click').pipe(map((_: Event) => [2, {type: 'Answer', answer: elements[2].inputTxt.value}])),
          fromEvent(elements[2].firstBtn, 'click').pipe(map((_: Event) => [2, {type: 'ChoseHonest', choice: true}])),
          fromEvent(elements[2].secondBtn, 'click').pipe(map((_: Event) => [2, {type: 'ChoseHonest', choice: false}])),
          fromEvent(elements[2].askBtn, 'click').pipe(map((_: Event) => [2, {type: 'Questions', subquestions: elements[2].inputTxt.value.split(';')}])),
          asapScheduler),
    merge(fromEvent(elements[3].answerBtn, 'click').pipe(map((_: Event) => [3, {type: 'Answer', answer: elements[3].inputTxt.value}])),
          fromEvent(elements[3].firstBtn, 'click').pipe(map((_: Event) => [3, {type: 'ChoseHonest', choice: true}])),
          fromEvent(elements[3].secondBtn, 'click').pipe(map((_: Event) => [3, {type: 'ChoseHonest', choice: false}])),
          fromEvent(elements[3].askBtn, 'click').pipe(map((_: Event) => [3, {type: 'Questions', subquestions: elements[3].inputTxt.value.split(';')}])),
          asapScheduler),
    asapScheduler) as Observable<[number, FEResponse]>; // TODO: Can I get rid of this cast?

// TODO: There's got to be a better way of doing this, than this nextEvent stuff.
let resolvers: Array<((r: FEResponse) => void) | null> = [null, null, null, null];

responseObservable.subscribe(r => {
    const i = r[0];
    const res = resolvers[i];
    elements[i].screenDiv.className = 'inactive';
    if(res !== null) {
        resolvers[i] = null;
        res(r[1]);
    }
});

const nextEvent: (i: number) => Promise<FEResponse> = i => {
    return new Promise<FEResponse>((resolve, reject) => { resolvers[i] = resolve; });
};

const requester: Requester<FEResponse> = (u: User, t: string, logIndex: number, d: any) => {
    console.debug({user: u, template: t, logIndex: logIndex, data: d});
    const res = resolvers[u.id];
    if(res !== null) {
        return new Promise((resolve, reject) => {
            resolvers[u.id] = r => { res(r); requester(u, t, logIndex, d).then(resolve); }
        });
    } else {
        const els = elements[u.id];
        els.roleLabel.textContent = u.id + ': ' + u.extraData.role; // TODO: The user ID is just for understandability. It wouldn't be included for real.
        els.inputTxt.value = '';
        els.questionLabel.textContent = d.question;
        if(t === 'adjudicate_template') {
            els.expertDiv.style.display = 'none';
            els.judgeDiv.style.display = 'block';
            els.extraLabel.textContent = d.subquestions.map((x: [Question, Answer]) => x[0]+': '+x[1]).join('\n\n');
            els.firstAnswerLabel.textContent = d.honest_answer;
            els.secondAnswerLabel.textContent = d.malicious_answer;
        } else {
            els.expertDiv.style.display = 'block';
            els.judgeDiv.style.display = 'none';
            els.extraLabel.textContent = t === 'malicious_template' ? d.honest_answer : '';
            els.firstAnswerLabel.textContent = '';
            els.secondAnswerLabel.textContent = '';
        }
        els.screenDiv.className = 'active';
        return nextEvent(u.id);
    }
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

// TODO: Make one of these that has a "pool" of users, and then make the experiment example with users
// spread over multiple, simultaneously running interaction scripts with the constraint that a user is
// an honest expert in at most interaction script, a malicious expert in at most one, and a judge in the
// remainder.
function makeSimpleAgentRequester(): AgentRequester {
    let userCount = 0;
    return extraData => Promise.resolve({id: userCount++, extraData: extraData});
}

function makeLimitedAgentRequester(limit: number): AgentRequester {
    let userCount = 0;
    return extraData => {
        if(userCount < limit) return Promise.resolve({id: userCount++, extraData: extraData});
        return Promise.reject('No more users');
    };
}

export const script = new FE(requester, makeLimitedAgentRequester(elements.length)); // export is temporary.
script.start('What is your question?').then(r => {
    console.log({done: r})
    console.log(script.log);
    const replayRequester = makeReplayRequester<FEResponse>(script.log.slice(0, 13), requester);
    const replayScript = new FE(replayRequester, makeLimitedAgentRequester(elements.length));
    replayScript.start('What is your question?').then(r2 => {
        console.log({replayDone: r2})
        console.log(replayScript.log);
    });
});
