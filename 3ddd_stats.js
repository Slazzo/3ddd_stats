function init_3ddd_stats() {
    
    const reg1 = /withdraw_stat\/(\w+)/g;
    const reg2 = /(<td>(.|\n)*?\/tr>)/g;
    const reg3 = /<td>(.*?)<\/td>/g;
    
    // data
    let products = {};
    let withdraws = [];
    
    let progress_target = 1;
    let progress_amount = 0;

    
    const wrap = document.getElementById('wrap');
    {   //inject apexcharts script
        const charts = document.createElement('script');
        wrap.appendChild(charts);
        charts.setAttribute('src', 'https://cdn.jsdelivr.net/npm/apexcharts');
        charts.onload = init_charts;
    }
      
    
    function parse_date(str) {
        const [dd, mm, year] = str.split('.');
        return new Date(year, mm - 1, dd, 12); //TBD: consider locale? 
    }
    
    function parse_float(str) {
        return parseFloat(str.replace(/ /g, ''));
    }
    
    function make_request(path, callable) {
        const xhr = new XMLHttpRequest();
        xhr.onload = callable;
        xhr.open('get', path);
        xhr.send();
    }
    
    //TBD: error handling
    function parse_profile_page(e) {
        //collect withdraws  
        const old_incomes = e.target.response.matchAll(reg2);
        for (const [_, payout] of old_incomes) {
            const matches = payout.matchAll(reg3);
            const [date, anchor, state, amount, invoice] = Array.from(matches, v => v[1]);
            const query = anchor.match(reg1)[0];
            withdraws.push( [parse_date(date).getTime(), query, parse_float(amount)] );
        }
        
        //sort withdraws by date (unnecessary because the collect is async anyway)
        withdraws.sort((l, r) => l[0] - r[0]);
        
        //for progress estimate
        progress_target = withdraws.length + 1;
        progress_amount = 0;

        //parse old withdraws
        for (const [date, query, amount] of withdraws) {
            make_request('https://3ddd.ru/user/' + query, parse_income_page);
        }
        
        //parse new income too
        make_request('https://3ddd.ru/user/income_new', parse_income_page);
    }
    
    //TBD: error handling
    function parse_income_page(e) {
        const sells = e.target.response.matchAll(reg2);
        for (const [_, sell] of sells) {
            const matches = sell.matchAll(reg3);
            const [date, anchor, amount] = Array.from(matches, v => v[1]);
            
            //TBD: make a smart insert in pre sorted array
            if (!products[anchor]) products[anchor] = [];
            products[anchor].push([ parse_date(date).getTime(), parse_float(amount) ]);
        }
        
        //report progress
        progress_clbk(++progress_amount, progress_target);
    };
    
    function progress_clbk(i, total) { /* does nothing until charts are instantiated */ }

    function init_charts() {
        //common chart settings
        const opt_price_per_prod = {
            series: [],
            stroke: { width: 1}, 
            chart: {
                type: 'line',
                stacked: false,
                height: 400,
                zoom: {
                    type: 'x',
                    enabled: true
                },
                toolbar: {
                    autoSelected: 'zoom'
                },
                animations: {
                    enabled: false
                }
            },
            dataLabels: {
                enabled: false
            },
            
            markers: {
                size: 0
            },
            title: {
                text: 'Price per product',
                align: 'center'
            },
            yaxis: {
                labels: {},
                title: {
                    text: 'Price'
                }
            },
            xaxis: {
                type: 'datetime',
            },
            annotations: {
                xaxis: []
            },
            noData: {
                text: 'Loading...'
            }
        };
        //deep copy, JS really?
        const opt_income_per_prod = JSON.parse(JSON.stringify(opt_price_per_prod));
        opt_income_per_prod.title.text = 'Income per product';
        opt_income_per_prod.yaxis.title.text = 'Income';
        opt_price_per_prod.yaxis.labels.formatter =
            opt_income_per_prod.yaxis.labels.formatter = v => v.toFixed(2);
        
        const stats_price = document.createElement('article');
        const stats_income = document.createElement('article');
        const stats_progress = document.createElement('article');
        
        stats_price.style.width = stats_income.style.width = 
            stats_progress.style.width = wrap.width;
        
        wrap.insertBefore(stats_price, wrap.firstChild);
        wrap.insertBefore(stats_income, stats_price);
        wrap.insertBefore(stats_progress, stats_income);

        var opt_progress = {
          chart: {
              height: 300,
              type: 'radialBar',
          },
          series: [0],
          labels: ['Progress'],
        };

        const chart_progress = new ApexCharts(stats_progress, opt_progress);
        const chart_income = new ApexCharts(stats_income, opt_income_per_prod);
        const chart_price = new ApexCharts(stats_price, opt_price_per_prod);
        
        chart_progress.render();
        chart_income.render();
        chart_price.render();
        

        function update_charts() {
            //clear charts, because we re append data
            const resetChart = {
                series: [],
                annotations: {}
            };
            chart_income.updateOptions(resetChart);
            chart_price.updateOptions(resetChart);

            //fill charts with updated data
            for ([anchor, data] of Object.entries(products)) {
                const name = (/>(.*?)</g).exec(anchor)[1]; //TBD: prbly shouldn't be here

                //data must be sorted by date (Y axis)
                data.sort((l, r) => l[0] - r[0]);

                let sum = 0;
                chart_income.appendSeries({
                    name: name,
                    data: data.map(v => [v[0], sum += v[1]])
                });
                chart_price.appendSeries({
                    name: name,
                    data: data
                });
            }
    

             //add withdraw annotations
            for (const [date, query, amount] of withdraws) {
                chart_income.addXaxisAnnotation({
                    x: date,
                    strokeDashArray: 1,
                    label: {
                        text: 'withdraw ' + amount
                    }
                });
            }
        };

        //override data progress callback 
        progress_clbk = (i, total) => {
            const progress = Math.floor(100*(i/total));
            chart_progress.updateSeries([progress]);
            
            //don't update charts if still in progress
            if (progress != 100) return;

            update_charts();

            //don't need it anymore
            chart_progress.destroy();
        }

        
        //now we are ready to parse and consume data
        make_request('https://3ddd.ru/user/withdraw_history', parse_profile_page);
        
        //guard
        window['3ddd_stats_executed'] = true;
    }
};
if (!window['3ddd_stats_executed']) init_3ddd_stats();