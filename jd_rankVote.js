/*
@name 排行榜做任务【支持多次循环任务】
@version 1.0
@note 依靠completionCnt / taskTimesLimit判断剩余次数；外层while循环多次刷新任务面板；必须appck
*/
const axios = require('axios');

let cookieArr = [];
// =========可自行修改时间配置(毫秒)=========
const SIM_BROWSE_MS = 6500;   // 模拟浏览等待 6.5秒
const AFTER_RECEIVE_GAP = 1000;//领取任务之后等待
const TASK_GAP_MS = 2000;     // 单个任务整套结束间隔
const ROUND_GAP = 3000;       // 每一轮全部任务跑完，等待后再刷新面板
const MAX_ACCOUNT_ROUND = 8;  // 单个账号最大轮次，防止死循环
// =========================================

!(async function main() {
    if (!process.env.JD_COOKIE) {
        console.log("❌请配置环境变量 JD_COOKIE");
        return;
    }
    cookieArr = process.env.JD_COOKIE.split(/&|\n/).filter(c => c.trim());
    console.log(`🔔排行榜做任务启动，账号数：${cookieArr.length}`);

    for (let ck of cookieArr) {
        await handleAccount(ck.trim());
        await sleep(3000);
    }
    console.log("\n✅全部账号处理完毕");
})().catch(err => {
    console.log("❌脚本异常", err.message);
});

/** 处理单个账号，while循环多轮刷新任务面板 */
async function handleAccount(cookie) {
    let ptPinMatch = cookie.match(/pt_pin=([^;]+)/);
    const pt_pin = ptPinMatch ? ptPinMatch[1] : "unknown";
    console.log(`\n========账号：${pt_pin} ========`);

    let round = 0;
    while (round < MAX_ACCOUNT_ROUND) {
        round++;
        console.log(`\n-----第${round}/${MAX_ACCOUNT_ROUND}轮，刷新任务面板-----`);
        let panel = await getTaskPanel(cookie);
        if (!panel) {
            console.log("⚠️获取任务面板失败，跳出账号循环");
            break;
        }
        const { remainVotes, taskList } = panel;
        console.log(`ℹ️当前剩余投票：${remainVotes}`);

        // ✅正确筛选条件：completionCnt < taskTimesLimit
        const todoTasks = taskList.filter(t => {
            const tt = Number(t.taskType);
            const done = Number(t.completionCnt || 0);
            const max = Number(t.taskTimesLimit || 0);
            return tt === 1 && done < max && !!t.encryptAssignmentId;
        });

        if (todoTasks.length === 0) {
            console.log("✅本轮没有待做浏览任务，退出账号循环");
            break;
        }
        console.log(`📝本轮待做浏览任务数量：${todoTasks.length}`);

        for (const t of todoTasks) {
            console.log(`\n----处理任务：${t.taskName} | ${t.completionCnt}/${t.taskTimesLimit} | encryptAssignmentId:${t.encryptAssignmentId}`);
            const baseParams = {
                encryptAssignmentId: t.encryptAssignmentId,
                itemId: Array.isArray(t.itemIdList) ? t.itemIdList[0] : "",
                jumpUrl: Array.isArray(t.jumpUrlList) ? t.jumpUrlList[0] : "",
                taskType: t.taskType
            };

            // 第一步 actionType=1 领取任务
            console.log("👉第一步：调用领取任务 actionType=1");
            const receiveRes = await doTaskApi(cookie, {...baseParams, actionType:"1"});
            if(!receiveRes.success){
                console.log(`⚠️领取任务失败，跳过该任务，返回：${JSON.stringify(receiveRes.data)}`);
                await sleep(TASK_GAP_MS);
                continue;
            }
            console.log("✅领取任务成功");
            await sleep(AFTER_RECEIVE_GAP);

            // 第二步 模拟浏览等待
            console.log(`⏳模拟浏览等待${SIM_BROWSE_MS/1000}秒...`);
            await sleep(SIM_BROWSE_MS);

            // 第三步 actionType=0 上报任务完成
            console.log("👉第二步：上报任务完成 actionType=0");
            const finishRes = await doTaskApi(cookie, {...baseParams, actionType:"0"});
            if(finishRes.success){
                console.log(`🎉任务【${t.taskName}】上报完成`);
            }else{
                console.log(`⚠️上报完成失败：${JSON.stringify(finishRes.data)}`);
            }
            await sleep(TASK_GAP_MS);
        }
        // 当前轮所有任务跑完，等待一会再重新拉面板获取最新completionCnt
        await sleep(ROUND_GAP);
    }

    // 全部轮次结束，打印最终票数
    const panelAfter = await getTaskPanel(cookie);
    if (panelAfter) {
        console.log(`\n🎫账号全部轮次结束，最终剩余投票机会：${panelAfter.remainVotes}`);
    }
}

/** 获取任务面板 query_TaskPanelList */
async function getTaskPanel(cookie) {
    const body = JSON.stringify({
        "callerApp": "noteRanking",
        "channel": "noteRanking",
        "queryType": "1"
    });
    const formData = new URLSearchParams();
    formData.append("functionId", "query_TaskPanelList");
    formData.append("appid", "newrank_action");
    formData.append("body", body);
    formData.append("client", "apple");
    formData.append("clientVersion", "16.0.0");

    try {
        const resp = await axios.post("https://api.m.jd.com/client.action", formData, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "jdapp;iPhone;16.0.0;;;M/5.0;appBuild/170980",
                "Referer": "https://pro.m.jd.com/mall/active/4JRfHorUDXgL77E9YdNxSCNMKwkJ/index.html",
                "Cookie": cookie
            },
            timeout: 12000
        });
        const data = resp.data;
        if (!data || !data.success || !data.result) return null;
        return {
            remainVotes: data.result.userRemainVotes || 0,
            taskList: data.result.taskList || []
        };
    } catch (e) {
        console.log("getTaskPanel 请求异常：", e.message);
        return null;
    }
}

/**
 * do_Task 统一封装
 * @param {*} cookie
 * @param {Object} params encryptAssignmentId,itemId,jumpUrl,taskType,actionType
 * @returns { {success:boolean,data:any} }
 */
async function doTaskApi(cookie, params) {
    const { encryptAssignmentId, itemId, jumpUrl, taskType, actionType } = params;
    const bodyJson = JSON.stringify({
        "callerApp": "noteRanking",
        "channel": "noteRanking",
        "encryptAssignmentId": encryptAssignmentId,
        "itemId": itemId || "",
        "jumpUrl": jumpUrl || "",
        "actionType": actionType,
        "taskType": String(taskType)
    });
    const formData = new URLSearchParams();
    formData.append("functionId", "do_Task");
    formData.append("appid", "newrank_action");
    formData.append("body", bodyJson);
    formData.append("client", "apple");
    formData.append("clientVersion", "16.0.0");

    try {
        const resp = await axios.post("https://api.m.jd.com/client.action", formData, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "jdapp;iPhone;16.0.0;;;M/5.0;appBuild/170980",
                "Referer": "https://pro.m.jd.com/mall/active/4JRfHorUDXgL77E9YdNxSCNMKwkJ/index.html",
                "Cookie": cookie
            },
            timeout:12000
        });
        const res = resp.data;
        if (!res || !res.success || !res.result) {
            return {success:false, data:res};
        }
        let bizOk = false;
        if(actionType === "1"){
            bizOk = res.result.code === "1";
        }else if(actionType === "0"){
            bizOk = res.result.code === "0";
        }
        return {
            success: bizOk,
            data: res
        };
    } catch (err) {
        console.log("do_Task网络异常：", err.message);
        return {success:false, data:null};
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
