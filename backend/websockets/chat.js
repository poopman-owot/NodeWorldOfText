function sanitizeColor(col) {
    var key = "#0123456789ABCDEF(RGB,)(HSV,)%."
    var res = "";
    for(var i = 0; i < col.length; i++) {
        var char = col[i];
        if(key.indexOf(char) > -1) {
            res += char;
        }
    }
    return res;
}

module.exports = async function(ws, data, send, vars) {
    var db = vars.db;
    var user = vars.user;
    var world = vars.world;
    var transaction = vars.transaction;
    var san_nbr = vars.san_nbr;
    var tile_coord = vars.tile_coord;
    var modules = vars.modules;
    var broadcast = vars.broadcast; // broadcast to current world
    var clientId = vars.clientId;
    var ws_broadcast = vars.ws_broadcast; // site-wide broadcast
    var add_global_chatlog = vars.add_global_chatlog;
    var add_page_chatlog = vars.add_page_chatlog;
    var html_tag_esc = vars.html_tag_esc;
    var topActiveWorlds = vars.topActiveWorlds;
    var getWss = vars.getWss;

    var props = JSON.parse(world.properties);
    var chat_perm = props.chat_permission;
    var is_member = user.stats.member;
    var is_owner = user.stats.owner;

    // sends `[ Server ]: <message>` in chat.
    function serverChatResponse(message, location) {
        send({
            kind: "chat",
            nickname: "[ Server ]",
            realUsername: "server",
            id: 0,
            message: message,
            registered: true,
            location: location
        })
    }
    
    var can_chat = false;
    if(chat_perm == 0 || chat_perm == undefined) can_chat = true;
    if(chat_perm === 1 && (is_member || is_owner)) can_chat = true;
    if(chat_perm === 2 && is_owner) can_chat = true;

    if(!(data.location == "global" || data.location == "page")) data.location = "page";

    if(data.location == "page" && !can_chat) {
        serverChatResponse("You do not have permission to chat here", "page")
        return;
    }

    var nick = "";
    if(data.nickname) {
        nick = data.nickname + "";
    }
    if(!user.staff) nick = nick.slice(0, 20);

    var msg = "";
    if(data.message) {
        msg = data.message + "";
    }
    msg = msg.trim();

    if(!msg) return;

    data.color += "";
    if(!user.staff) data.color = sanitizeColor(data.color);
    if(!data.color) data.color = "#000000";
    if(!user.staff) data.color = data.color.slice(0, 20);
    data.color = data.color.trim();

    var msNow = Date.now();

    var second = Math.floor(msNow / 1000);
    var chatsEverySecond = 3

    if(ws.lastChatSecond != second) {
        ws.lastChatSecond = second;
        ws.chatsSentInSecond = 0;
    } else {
        if(ws.chatsSentInSecond >= chatsEverySecond) {
            if(!user.staff) {
                serverChatResponse("You are chatting too fast.", data.location);
                return;
            }
        } else {
            ws.chatsSentInSecond++;
        }
    }

    if(!user.staff) {
        msg = msg.slice(0, 400);
    } else {
        msg = msg.slice(0, 3030);
    }

    // TODO: Refactor

    // WARNING: Don't look ahead. Graphic content

    // chat commands
    if(user.operator && msg.charAt(0) == "/") {
        var args = msg.toLowerCase().substr(1).split(" ")
        switch(args[0]) {
            case "worlds":
                var topCount = 5;
                var lst = topActiveWorlds(topCount);
                var worldList = "";
                for(var i = 0; i < lst.length; i++) {
                    var row = lst[i];
                    if(row[1] == "") {
                        row[1] = "(main)"
                    } else {
                        row[1] = `<a href="/${row[1]}" style="color: blue; text-decoration: underline;">${row[1]}</a>`;
                    }
                    worldList += "-> " + row[1] + " [" + row[0] + "]";
                    if(i != lst.length - 1) worldList += "<br>"
                }
                var listWrapper = `
                    <div style="background-color: #dadada; font-family: monospace;">
                        ${worldList}
                    </div>
                `;
                serverChatResponse("Currently loaded worlds (top " + topCount + "): " + listWrapper, data.location)
                return;
            case "ban":
                var id = args[1];
                serverChatResponse(JSON.stringify(args), data.location);
                return;
            case "kick":
                var id = args[1];
                serverChatResponse(JSON.stringify(args), data.location);
                return;
            case "banip":
                var ip = args[1];
                serverChatResponse(JSON.stringify(args), data.location);
                return;
            case "kickip":
                var ip = args[1];
                serverChatResponse(JSON.stringify(args), data.location);
                return;
            case "whois":
                var id = args[1];
                var wss = getWss();
                var ipData = "Client not found"
                wss.clients.forEach(function(e) {
                    if(e.clientId != id) return;
                    ipData = JSON.stringify([e._socket.remoteAddress, e._socket.address(), ws.ipHeaderAddr])
                })
                serverChatResponse(ipData, data.location);
                return;
            case "help":
                serverChatResponse(
                    `
                        Command list:<br>
                        <div style="background-color: #dadada; font-family: monospace;">
                        -&gt; /nick &lt;nickname&gt; :: changes your nickname
                        <br>
                        -&gt; /help :: lists all commands
                        <br>
                        -&gt; /worlds :: list all worlds
                        <br>
                        -&gt; /ban &lt;id&gt; :: ban user from chat by id (referenced by IP)
                        <br>
                        -&gt; /kick &lt;id&gt; :: kick user's client from chat by id
                        <br>
                        -&gt; /banip &lt;ip&gt; :: ban user from chat by ip
                        <br>
                        -&gt; /kickip &lt;ip&gt; :: kick all user's clients from chat by ip
                        <br>
                        -&gt; /whois &lt;id&gt; :: get user ip address from id
                        </div>
                    `, data.location);
                return;
        }
    } else if(msg.charAt(0) == "/") {
        var args = msg.toLowerCase().substr(1).split(" ")
        switch(args[0]) {
            case "help":
                serverChatResponse(
                    `
                        Command list:<br>
                        <div style="background-color: #dadada; font-family: monospace;">
                        -&gt; /nick &lt;nickname&gt; :: changes your nickname
                        <br>
                        <div style="background-color: #d3d3d3">-&gt; /help :: lists all commands</div>
                        </div>
                    `, data.location);
            return;
        }
    }

    var chatData = {
        nickname: user.operator ? nick : html_tag_esc(nick),
        realUsername: user.username,
        id: clientId,
        message: user.operator ? msg : html_tag_esc(msg),
        registered: user.authenticated,
        location: data.location,
        op: user.operator,
        admin: user.superuser,
        staff: user.staff,
        color: data.color
    };

    var isCommand = false;
    if(msg.startsWith("/") || msg.startsWith("\\")) {
        isCommand = true;
    }

    if(!isCommand) {
        if(data.location == "page") {
            add_page_chatlog(chatData, world.name);
        } else if(data.location == "global") {
            add_global_chatlog(chatData);
        }
    }

    var websocketChatData = Object.assign({
        kind: "chat",
        channel: vars.channel
    }, chatData)

    var chatOpts = {
        // Global and Page updates should not appear in worlds with chat disabled
        chat_perm
    }

    if(!isCommand) {
        if(data.location == "page") {
            broadcast(websocketChatData, chatOpts)
        } else if(data.location == "global") {
            ws_broadcast(websocketChatData, void 0, chatOpts)
        }
    }
}