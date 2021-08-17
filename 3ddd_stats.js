(()=>{

    function collect() 
    {
        const cache = (() => {
            
            const key = '3ddd_stats_cache';

            function loadData() {
                const str = localStorage.getItem(key);
                if(str) return JSON.parse(str);
                return {};
            }

            function saveData(data) {
                const str = JSON.stringify(data);
                localStorage.setItem(key, str);
            }

            function clearData() {
                localStorage.removeItem(key);
            }

            const data = loadData();
            let dirty = false;

            return {
                save() {
                    if(dirty) saveData(data);
                },
                has(query) {
                    return query in data;
                },
                get(query) {
                    return data[query];
                },
                set(query, value) {
                    data[query] = value;
                    dirty = true;
                },
                copy() { 
                    return JSON.parse(JSON.stringify(Array.from(Object.entries(data), ([k,v]) => v))); 
                },
                clear() { 
                    clearData(); 
                }
            };
        })();


        function parse_date(str) 
        {
            const [dd, mm, year] = str.split('.');
            return new Date(year, mm - 1, dd, 12); //TBD: consider locale? 
        }


        function parse_float(str) 
        {
            return parseFloat(str.replace(/ /g, ''));
        }


        function* parse_fields(str) {
            const fields = str.matchAll(/(<td>(.|\n)*?\/tr>)/g);
            for (const [_, field] of fields) {
                const entry = field.matchAll(/<td>(.*?)<\/td>/g);
                const data = Array.from(entry, v => v[1]);
                yield data;
            }
        }


        async function make_request(path) 
        {
            return fetch(path).then(async(res) => {
                if(!res.ok) throw (res.statusText+' '+res.status);
                return { url:res.url, str:await (res.text()) };
            });
        };


        function parse_uri(url)
        {
            const res = (/((([httpsw]{2,5}):\/\/)?(.+\.[^/ :]+)(:(\d+))?(\/([^ ?]+)?)?\/?\??([^/ ]+\=[^/ ]+)?)/gi).exec(url);
            return {
                'protocol': res[3] || res[2],
                'domain' : res[4],
                'port': res[6] || (res[3] == 'https' || res[3] == 'wss' ? '443' : '80'),
                'resource': res[8] || '/',
                'query': res[9] || ''
            };
        }


        function* iterate_pages(res) 
        {
            const uri = parse_uri(res.url);
            const pagei = parseInt(/page=([0-9]+)/g.exec(uri.query)) || 1;
            const regex = new RegExp( uri.resource + "\\?page=([0-9]+)", 'g');
            const pages = Array.from(res.str.matchAll(regex), v => parseInt(v[1]));
            const pagel = pages.length > 0 ? Math.max.apply(Math, pages) : pagei;
            
            //generate url for the next page
            for(let i=pagei; i<pagel; ++i) {
                yield uri.protocol + '://' + uri.domain + '/' + uri.resource +'?page=' + (i+1);
            }
        }
        

        async function parse_pages(url, parser) 
        {
            return make_request(url).then(res => {
                    const tasks = Array.from(iterate_pages(res), 
                        v => make_request(v).then(parser));
                    return Promise.all(tasks.concat(parser(res)));
                });
        }


        function retry(call, ntimes, error) {
            if(--ntimes < 1) return call().catch(err => Promise.reject(error+' : '+err));
            return call().catch(async(e) => {
                await new Promise((resolve) => setTimeout(resolve, 3000/ntimes));
                return retry(call, ntimes, error);
            });
            
        }


        function parse_withdrawals() 
        {
            const withdrawals = [];
            
            function parser(res) 
            {
                for (const [date, anchor, _, amount] of parse_fields(res.str)) {
                    const query = anchor.match(/withdraw_stat\/(\w+)/g)[0];
                    const data = {
                        'query': query,
                        'time': parse_date(date).getTime(), 
                        'amount': parse_float(amount),
                    };
                    withdrawals.push(data);
                }
            };
            
            return retry(parse_pages.bind(null,'https://3ddd.ru/user/withdraw_history', parser), 3, 
                'error accessing resource withdraw_history')
                .then(() => withdrawals);
        };

        
        function parse_products(withdrawals)
        { 
            function make_parser_for(products) {
                function parser (res) 
                {
                    for (const [date, anchor, amount] of parse_fields(res.str)) {
                        const data = [ parse_date(date).getTime(), parse_float(amount) ];

                        if(anchor in products) products[anchor].push(data);
                        else products[anchor] = [data];
                    }
                };
                return parser;
            }

            //chain a request/parsing/caching task for withdrawals without products
            const make_task = withdrawal => {
                if('products' in withdrawal) 
                    return Promise.resolve(withdrawal);

                return retry(parse_pages.bind(null, 'https://3ddd.ru/user/' + withdrawal.query, 
                                make_parser_for(withdrawal.products = {})), 3, 'error accessing resource ' + withdrawal.query)
                    .then(() => cache.set(withdrawal.query, withdrawal))
                    .then(() => Promise.resolve(withdrawal));
            };

            return withdrawals.map(make_task);
        }

        const parsing = Promise.resolve('offline mode')
            //fetch withdrawals query
            .then(parse_withdrawals)
            //reuse cached withdrawals
            .then( v => v.map(w => cache.has(w.query) ? cache.get(w.query) : w))
            //new income is not part of withdrawals, add it
            .then( v => v.concat({ query: 'income_new', time: Date.now() }))
            //we are offline, use data from cache
            .catch(err => {
                const copy = cache.copy();
                if(Object.keys(copy).length === 0) throw err;
                console.warn('3ddd_stats:',err,'\n!!! using local cache'); 
                return copy;
            })
            //launch tasks
            .then(parse_products)


        //append cache saving when all tasks are settled
        parsing.then(tasks => Promise.all(tasks))
            .finally(() => cache.save())
            .catch(() => { /*don't care*/ });

        return parsing;
    }
    

    function isSoldBy3dsky(date, amount) {
        //assume everything higher than 100rub was sold on 3dsky
        return amount > 100;
    };


    function throttle(func, ms) {
        let isThrottled = false, savedArgs, savedThis;
        function wrapper() {
            if (isThrottled) { 
                savedArgs = arguments;
                savedThis = this;
                return;
            }
            isThrottled = true;
            func.apply(this, arguments); 
            setTimeout(function() {
                isThrottled = false;
                if (savedArgs) {
                    wrapper.apply(savedThis, savedArgs);
                    savedArgs = savedThis = null;
                }
            }, ms);
        }
        return wrapper;
    }


    function createElement(type, attributes) {
        const el = document.createElement(type);
        for(const name in attributes)
            el.setAttribute(name, attributes[name]);
        return el;
    }


    class Model {
        #callable = {};
        #database = {};
        
        get(name) { 
            let property = this.#database;
            for(const p of name.split('.')) {
                property = property[p];
                if(!property) break;
            }
            return property;
        }

        set(name, value) { 
            let property = this.#database;
            const names = name.split('.');
            const last = names.pop();
            for(const p of names) {
                if(!property[p]) property[p] = {};
                property = property[p];
            }
            this.notify(name,  property[last] = value); 
        }

        subscribe(name, func) { 
            if (this.#callable[name])
                this.#callable[name].push(func); 
            else this.#callable[name] = [func];
        }

        notify(name, value) { 
            if(typeof value === 'object') {
                for(const [n,v] of this.#iterateObject(value)) {
                    const p = name + '.' + n;
                    if(this.#callable[p]) {
                        this.#callable[p].forEach(f => f(p, v));
                    }
                }
            }

            if(this.#callable[name])
                 this.#callable[name].forEach(f => f(name, value));
                 
            for(const p of this.#iterateParameter(name))
             if(this.#callable[p]) {
                 const v = this.get(p);
                 this.#callable[p].forEach(f => f(p, v));
            }
        }

        *#iterateObject(object) {
            for(const [name, value] of Object.entries(object))
            {
                if(typeof value === 'object')
                    for(const [n,v] of this.#iterateObject(value))
                        yield [name+'.'+n, v];
                yield [name,value];
            }
        }

        *#iterateParameter(name) {
            const parts = name.split('.').slice(0,-1);
            while(parts.length) {
                yield parts.join('.');
                parts.pop();
            }
        }
    };
    

    class ModelView {
        #model;

        constructor(model) { this.#model = model; }
        
        subscribe(name, func) { this.#model.subscribe(name, func); }
        
        notify(name, value) { this.#model.notify(name, value); }
        
        set(name, value) { this.#model.set(name, value); }
        
        get(name) { this.#model.get(name); }
        
        model() { return this.#model; }
    };


    class Component extends ModelView {
        #body; #title;

        constructor(model, wrapper) {
            super(model);
            this.#body = createElement('div');
            wrapper.append(this.#body);
        }

        append(...children) { this.#body.append(...children); }
        
        remove() { this.#body.remove(); }
    };
    
    
    class DateInputComponent extends Component {

        constructor(model, parent, param, options) {
            super(model, parent);
            const input = createElement('input',{id:param+'.value', type:'date'});
            const label = createElement('label',{'for':input.id});

            input.onchange = e => {
                const time = new Date(e.target.value).getTime();
                if(!isNaN(time)) super.set(input.id, time);
            }

            super.subscribe(param, (n,v) => {
                if(n!=param) return;
                label.textContent = v.text || '';
                if('min' in v) {
                    input.valueAsNumber = v.min;
                    input.setAttribute('min', input.value);
                }
                if('max' in v) {
                    input.valueAsNumber = v.max;
                    input.setAttribute('max', input.value);
                }
                input.valueAsNumber = v.value;
                input.readOnly = v.readOnly || false;
                input.disabled = v.disabled || false; 
            })

            super.set(param, options);
            super.append(label, input);
        }
     };


    class DropDownComponent extends Component {

        constructor(model, parent, param, options) {
            super(model, parent);
            const select = createElement('select', {id:param+'.value'});
            const label = createElement('label', {'for':select.id});
            select.onchange = e => {
                const value = select.options[select.selectedIndex].text;
                super.set(select.id, value);
            }
            super.subscribe(param, (n,v) => {
                if(n != param) return;
                label.textContent = v.text || '';
                select.options.length = 0;
                for(const text of (v.labels || [])) {
                    const el = createElement('option'); el.text = text; select.append(el);
                }
                select.value = v.value;
                select.readOnly = v.readOnly || false;
                select.disabled = v.disabled || false;
            })
            super.set(param, options);
            super.append(label, select);
        }
    };


    class CheckBoxComponent extends Component {

        constructor(model, parent, param, options) {
            super(model, parent);
            const input = createElement('input', {id:param+'.value', type:'checkbox'});
            const label = createElement('label', {'for': input.id});

            input.onchange = e => super.set(input.id, e.target.checked);

            super.subscribe(param, (n,v) => {
                if(n != param) return;
                label.textContent = v.text || '';
                input.checked = v.value;
                input.readOnly = v.readOnly || false;
                input.disabled = v.disabled || false; 
            });
            super.set(param,options);
            super.append(input, label);
        }
    };


    class TableOptionsComponent extends Component {
        #form;

        constructor(model, parent) {
            super(model, parent);

            this.#form = createElement('form', 
                { style:'display:flex; flex-direction:row; align-items:center; justify-content:flex-start; gap:16px'});

            new DateInputComponent(model, this.#form, 'table.filter.from', {text:'From:', disabled:true, value: 0 })
            new DateInputComponent(model, this.#form, 'table.filter.upto', {text:'  To:', disabled:true, value: Date.now() })

            super.subscribe('table.products',(_,products)=>{
                let min = Date.now();
                let max = 0;
                for(const [_,data] of Object.entries(products)) {
                    if(!data.length) continue;

                    let earliest = data[0][0], 
                        latest = data[data.length-1][0];
                        
                    if(min > earliest) min = earliest;
                    if(max < latest) max = latest;
                }
                super.model().set('table.filter', {
                    from:{value:min, min:min, max:max, text:'From:', disabled:false},
                    upto:{value:max, min:min, max:max, text:'  To:', disabled:false}
                });
            });
            super.append(this.#form);
        }
    };


    class TableComponent extends Component {
        #header; #body; #options; #table; #config;

        constructor(model, parent) {
            super(model, parent);
            this.#body = createElement('div');
            this.#header = createElement('div');
            super.append(this.#header, this.#body);

            this.#config = {
                selectable:true,
                selectablePersistence:true,
                height:"400px",
                autoColumns:false,
                layout:"fitDataFill",
                placeholder:"No Data",
                rowSelectionChanged: ()=>{},
                columns:[
                    {title:'Select', formatter:"rowSelection", titleFormatter:"rowSelection", hozAlign:"center", headerSort:false},
                    {title:'Name', field:'anchor', formatter:'html', headerFilter:"input"},
                    {title:'Sales', columns:[
                        {title:'3ddd',  field:'sales.3ddd'},
                        {title:'3dsky', field:'sales.3dsky'},
                        {title:'total', field:'sales.total'},
                    ]},
                    {title:'Income', columns:[
                        {title:'3ddd',  field:'income.3ddd', formatter:"money"},
                        {title:'3dsky', field:'income.3dsky',formatter:"money"},
                        {title:'total', field:'income.total',formatter:"money"},
                    ]}],
            };
        }

        async init() {
            await new Promise(async(resolve, reject) => {
                const css = 'https://unpkg.com/tabulator-tables@4.9.3/dist/css/tabulator.min.css';
                const jss = 'https://unpkg.com/tabulator-tables@4.9.3/dist/js/tabulator.min.js';
                const check = fetch(css).then(res=>{ if (!res.ok) throw 'failed to load Tabulator css'});
                await check.then(() => document.getElementsByTagName("head")[0]
                    .insertAdjacentHTML("beforeend", '<link rel=\"stylesheet\" href=\"'+css+'\"/>'))
                    .catch(reject);
                
                const script = createElement('script',{ src:jss });
                script.onload = () => resolve(script);
                script.onerror = reject;
                this.#body.appendChild(script);
            }).catch(err => { 
                super.remove();
                throw 'failed to load Tabulator script';
            });

            this.#config.rowSelectionChanged = (data, rows) => {
                try {
                    data = this.#table.getRows("active")
                        .filter(r=>r.isSelected())
                        .map(r => r.getData());
                } catch {}
                setTimeout(super.set.bind(this, 'chart.products', data), 0)
            }
            this.#table = new Tabulator(this.#body, this.#config);
            this.#options = new TableOptionsComponent(super.model(), this.#header);
            
            const throttledUpdate = throttle(this.#updateFromModel.bind(this), 1000);

            super.subscribe('table.products', throttledUpdate);
            super.subscribe('table.filter.from.value', throttledUpdate);
            super.subscribe('table.filter.upto.value', throttledUpdate);
        }

        #updateFromModel() {
            this.#update(super.model().get('table.products') || {});
        }

        #update(products) {
            const from = super.model().get('table.filter.from.value') || 0, 
                  upto = super.model().get('table.filter.upto.value') || Date.now();

            const day = time => time / 864e5;
            const processed = [];
            for (const [anchor, data] of Object.entries(products)) {
                const product = { 
                    'anchor': anchor, 'name': (/>(.*?)</g).exec(anchor)[1],
                    'data': data.filter(([date, amount]) => day(date) >= day(from) && day(date) <= day(upto)), 
                    'sales': { 'total':0, '3ddd':0, '3dsky':0 },
                    'income':{ 'total':0, '3ddd':0, '3dsky':0 }
                };

                product.data.forEach( ([date, amount]) => {
                    product.income.total += amount;
                    product.sales.total++;
                    const site = isSoldBy3dsky(date, amount) ? '3dsky':'3ddd';
                    product.income[site] += amount;
                    product.sales[site]++;
                });


                if(product.sales.total)
                    processed.push(product);
            }

            return this.#table.setData(processed);
        }
    };
    

    class ChartOptionsComponent extends Component {
        #form;

        constructor(model, parent) {
            super(model, parent);
            this.#form = createElement('form', 
                { style:'display:flex; flex-direction:row; align-items:center; justify-content:flex-start; gap:16px'});

            new DropDownComponent(model, this.#form, 'chart.series', {text:'Series:', value:'per product', labels:['all selected','per product']});
            new DropDownComponent(model, this.#form, 'chart.filter', {text:'Filter:', value:'none', labels:['none','3ddd','3dsky']});
            new DropDownComponent(model, this.#form, 'chart.mapper', {text:'Mapper:', value:'price', labels:['price','income']});
            new CheckBoxComponent(model, this.#form, 'chart.display.annotations', {text:'Annotations', value:true});
            new CheckBoxComponent(model, this.#form, 'chart.display.legend', {text:'Legend', value:true});
            new DropDownComponent(model, this.#form, 'chart.display.type', {text:'Type:', value:'line', labels:['line','area','scatter']});
            new CheckBoxComponent(model, this.#form, 'chart.display.stacked', {text:'Stacked', value:false, disabled:true});
            
            super.subscribe('chart.mapper.value', (_,v) => {
                if(v == 'price') {
                    model.set('chart.display.stacked.value', false);
                    model.set('chart.display.stacked.disabled', true);
                } else {
                    model.set('chart.display.stacked.disabled', false);
                }
            })
            super.subscribe('chart.display.stacked.value', (_,v) => {
                if( v == true && model.get('chart.mapper.value') == 'price') {
                    model.set('chart.display.stacked.value', false);
                }
            })
            super.append(this.#form);
        }
    };


    class ChartComponent extends Component {
        #header; #body;  #options; #chart; #config;

        constructor(model, parent) {
            super(model, parent);
            this.#body = createElement('div');
            this.#header = createElement('div');
            super.append(this.#header, this.#body);
            
            this.#config = {
                series: [],
                stroke: { width: 2, curve: 'straight'}, 
                chart: {
                    id:'chart-graph',
                    height: 400, 
                    type: 'line',
                    stacked: false,
                    zoom: { type: 'x', enabled: true },
                    toolbar: { autoSelected: 'zoom'},
                    animations: {enabled: true}
                },
                legend: { show: true, showForSingleSeries: true },
                toolbar: { 
                    show : true,
                    tools: {
                        download: true,
                        selection: true,
                        zoom: true,
                        zoomin: true,
                        zoomout: true,
                        pan: true,
                    }
                },
                xaxis : { labels: {}, type: 'datetime' },
                yaxis : { labels: { formatter: v => {if(v) return v.toFixed(2); return v} } },
                dataLabels: {enabled: false},
                markers: { size: 0, strokeWidth:0 },
                fill: {type:'solid',},
                title: { text: '', align: 'center'},
                annotations: { position:'front', xaxis:[] },
                noData: { text: 'No data'}
            };
            
        }

        async init() {
            await new Promise((resolve, reject) => {
                const script = createElement('script', {src:'https://cdn.jsdelivr.net/npm/apexcharts'});
                script.onload = () => resolve(script);
                script.onerror = reject;
                this.#body.appendChild(script);
            }).catch(err => { 
                super.remove();
                throw 'failed to load ApexCharts script';
            });

            this.#chart = new ApexCharts(this.#body, this.#config);
            await this.#chart.render();
            
            this.#options = new ChartOptionsComponent(super.model(), this.#header);

            const throttledUpdate = throttle(this.#updateFromModel.bind(this), 1000);

            super.subscribe('withdrawals', (_, data) => this.#updateAnnotations(data));
            super.subscribe('chart.products', throttledUpdate);
            super.subscribe('chart.series.value', throttledUpdate);
            super.subscribe('chart.mapper.value', throttledUpdate);
            super.subscribe('chart.filter.value', throttledUpdate);
            super.subscribe('chart.display', (n,v) => {
                if(n != 'chart.display') return;
                this.#config.chart.type = v.type.value.toLowerCase();
                this.#config.markers.size = this.#config.chart.type == 'scatter' ? 2 : 0;
                this.#config.chart.stacked = v.stacked.value;
                this.#config.annotations.position = v.annotations.value ? 'front' : 'hidden'; 
                this.#config.legend.show = v.legend.value; 
                this.#chart.updateOptions(this.#config);
            });
        }

        #updateFromModel() {
            this.#update(super.model().get('chart.products'));
        }

        #update(products) {
            const seriesType = super.model().get('chart.series.value');
            const mapperType = super.model().get('chart.mapper.value');
            const filterType = super.model().get('chart.filter.value');

            if(seriesType == 'all selected') {
                const res = {name:`All ${products.length} selected`, data:[] };
                for(const p of products)
                    res.data.push(...p.data);
                res.data.sort((l,r) => l[0] - r[0]);
                products = [res];
            }

            let totalDataPoints = 0;
            const filter = {
                'none'    : () =>     { ++totalDataPoints; return true; },
                '3ddd'   : ([t,v]) => { ++totalDataPoints; return !isSoldBy3dsky(t,v); },
                '3dsky'  : ([t,v]) => { ++totalDataPoints; return  isSoldBy3dsky(t,v); },
            }[filterType];
            
            const mapper = {
                'price': ()=> { return v => v },
                'income': ()=> { let sum=0; return ([t,v]) => [t, sum+=v]; }
            }[mapperType];

            this.#config.title.text = mapperType + ' per product';
            this.#config.series = Array.from(products, p =>{
                return {
                    name: p.name,
                    data: p.data.filter(filter).map(mapper())
                    }
            });
            this.#config.chart.animations.enabled = products.length <= 100 && totalDataPoints < 1000;
            return this.#chart.updateOptions(this.#config);
        }

        #updateAnnotations(withdrawals) {
            this.#config.annotations.xaxis = withdrawals
                .filter(w => 'amount' in w)
                .map(w => {
                return { x: w.time, label: { text: 'withdraw ' + w.amount }, strokeDashArray: 1};
            });
            //return this.#chart.updateOptions(this.#config);
        }
    };


    class ProgressComponent extends Component {
        #progressTitle; #progressBar;

        constructor(model, parent) {
            super(model, parent);
            this.#progressTitle = createElement('label', {style:'width:100%'});
            this.#progressBar = createElement('progress', {style:'width:100%'});
            super.append(this.#progressTitle, this.#progressBar);
            this.subscribe('progress', (_,o) => {if(o) this.#update(o.text, o.value);})
        }

        #update(text, val = 'pending') {
            this.#progressTitle.textContent = text;

            if(val == 'pending') delete this.#progressBar.value;
            else this.#progressBar.value = val;
            
            if(val == 1) setTimeout(()=>{
                if(val == 1) this.#progressBar.style.visibility = 'hidden';
            }, 1000);

            this.#progressBar.style.visibility = 'visible';     
        }
    };


    class MainComponent extends Component {
       #body; #chart; #table;

        constructor(model, parent) {
            super(model, parent);

            this.#body = createElement('div');
            this.#table = new TableComponent(model, this.#body);
            this.#chart = new ChartComponent(model, this.#body);

            super.append(this.#body);
        }

        async init() {
            const table = this.#table.init();
            const chart = this.#chart.init()
                //without charts still can display data
                .catch(err => console.warn('3ddd_stats warning:', err));
                
            await Promise.all([table, chart]);
        }
    };


    class App {
        #model; #title; #body; #progress; #main;

        constructor(wrapper) {
            const oldbody = document.getElementById('3ddd-stats-main');
            if(oldbody) oldbody.remove();

            this.#body = createElement('div', {id:'3ddd-stats-main'});
            const href = "https://github.com/slazzo/3ddd_stats";
            this.#title = createElement('h3', {style:'width:100%; text-align:right;'}); 
            this.#title.innerHTML ='3ddd_stats script '
                + '<a target="_blank" href=\"'+href+'\">source code</a>';           
            this.#body.append(this.#title);

            this.#model = new Model();
            this.#progress = new ProgressComponent(this.#model, this.#body);
            this.#main = new MainComponent(this.#model, this.#body);
            
            wrapper.insertBefore(this.#body, wrapper.firstChild);

            const dateOptions = {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour:'numeric',
                minute:'numeric',
                hours12: false
            };
            this.dateFormatter = new Intl.DateTimeFormat('default', dateOptions);
        }

        async init() {
            window.scrollTo({ top: this.#title, behavior: 'smooth'});

            this.#model.notify('progress', { text:'Loading scripts', value:'pending'});
            await this.#main.init()
                .catch(err => {
                    this.#body.remove();
                    throw err;
                });

            let withdrawals = [];
            this.#model.notify('progress', { text:'Parsing withdrawals', value:'pending'});
            return collect().then( tasks => {
                //for progress estimate
                let progress_target = tasks.length;
                let progress_amount = 0;
                const progress = () => 100.0*(++progress_amount/progress_target)*0.01;

                tasks.forEach( p =>
                        p.then(w => withdrawals.push(JSON.parse(JSON.stringify(w))))
                        .then(() => this.#model.notify('progress', { text:'Parsing income', value:progress()}))
                        .then(() => this.display(withdrawals))
                        .catch(() => { /*don't care*/ })
                        );

                return Promise.all(tasks).then(() => {
                    if(withdrawals.length > 0) {
                        const lastUpdateTime = new Date(withdrawals[withdrawals.length-1].time);
                        this.#model.notify('progress', { text:'Last update '+ this.dateFormatter.format(lastUpdateTime), value:1})
                    }
                });
            }).catch(err => { 
                this.#body.remove();
                throw err; 
            });
        }


        display(withdrawals) {
            //sort withdrawals by date
            withdrawals.sort((l,r) => l.time - r.time);

            //merge product sales from multiple withdrawals
            const products = {};
            for(const w of withdrawals) {
                for(const [anchor, data] of Object.entries(w.products)) {
                    data.sort((l,r) => l[0]-r[0]); //sort sales by date
                    if(anchor in products) products[anchor].push(...data);
                    else products[anchor] = [...data];
                }
            }

            this.#model.set('withdrawals', withdrawals);
            this.#model.set('table.products', products);
        }
    }


    const run = async() => {
        const wrapper = document.getElementById('wrap');
        if(!wrapper) throw "couldn't find wrap element";

        const app = new App(wrapper);
        return app.init();
    }

    run().catch(err => console.error('3ddd_stats error:', err));
    
})();
