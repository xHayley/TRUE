/**
 * Rooms
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Every chat room and battle is a room, and what they do is done in
 * rooms.js. There's also a global room which every user is in, and
 * handles miscellaneous things like welcoming the user.
 *
 * @license MIT license
 */

const TIMEOUT_DEALLOCATE = 15*60*1000;
const REPORT_USER_STATS_INTERVAL = 1000*60*10;

var modlog = modlog || fs.createWriteStream('logs/modlog.txt', {flags:'a+'});

var GlobalRoom = (function() {
	function GlobalRoom(roomid) {
		this.id = roomid;
		this.i = {};

		// init rooms
		this.rooms = [];
		this.numRooms = 0;
		this.searchers = [];

		// Never do any other file IO synchronously
		// but this is okay to prevent race conditions as we start up PS
		this.numRooms = 0;
		try {
			this.numRooms = parseInt(fs.readFileSync('logs/lastbattle.txt')) || 0;
		} catch (e) {} // file doesn't exist [yet]

		// this function is complex in order to avoid several race conditions
		var self = this;
		this.writeNumRooms = (function() {
			var writing = false;
			var numRooms;	// last numRooms to be written to file
			var finishWriting = function() {
				writing = false;
				if (numRooms !== self.numRooms) {
					self.writeNumRooms();
				}
			};
			return function() {
				if (writing) return;
				numRooms = self.numRooms;
				writing = true;
				fs.writeFile('logs/lastbattle.txt.0', '' + numRooms, function() {
					// rename is atomic on POSIX, but will throw an error on Windows
					fs.rename('logs/lastbattle.txt.0', 'logs/lastbattle.txt', function(err) {
						if (err) {
							// This should only happen on Windows.
							fs.writeFile('logs/lastbattle.txt', '' + numRooms, finishWriting);
							return;
						}
						finishWriting();
					});
				});
			};
		})();

		// init users
		this.users = {};
		this.userCount = 0; // cache of `Object.size(this.users)`
		this.maxUsers = 0;
		this.maxUsersDate = 0;

		this.reportUserStatsInterval = setInterval(
			this.reportUserStats.bind(this),
			REPORT_USER_STATS_INTERVAL
		);

		if (config.reportbattlesperiod) {
			this.reportBattlesInterval = setInterval(
				this.reportRecentBattles.bind(this),
				config.reportbattlesperiod
			);
		}

		if (!config.herokuhack) {
			this.sweepClosedSocketsInterval = setInterval(
				this.sweepClosedSockets.bind(this),
				1000 * 60 * 10
			);
		}
	}
	GlobalRoom.prototype.type = 'global';

	GlobalRoom.prototype.formatListText = '|formats';

	GlobalRoom.prototype.reportUserStats = function() {
		if (this.maxUsersDate) {
			LoginServer.request('updateuserstats', {
				date: this.maxUsersDate,
				users: this.maxUsers
			}, function() {});
			this.maxUsersDate = 0;
		}
		LoginServer.request('updateuserstats', {
			date: Date.now(),
			users: Object.size(this.users)
		}, function() {});
	};

	// Deal with phantom xhr-streaming connections.
	GlobalRoom.prototype.sweepClosedSockets = function() {
		for (var i in this.users) {
			var user = this.users[i];
			user.connections.forEach(function(connection) {
				if (connection.socket &&
						connection.socket._session &&
						connection.socket._session.recv &&
						(connection.socket._session.recv.protocol === 'xhr-streaming')) {
					connection.socket._session.recv.didClose();
				}
			});
		}
	};

	GlobalRoom.prototype.getFormatListText = function() {
		var formatListText = '|formats';
		var curSection = '';
		for (var i in Tools.data.Formats) {
			var format = Tools.data.Formats[i];
			if (!format.challengeShow && !format.searchShow) continue;

			var section = format.section;
			if (section === undefined) section = format.mod;
			if (!section) section = '';
			if (section !== curSection) {
				curSection = section;
				formatListText += '||'+section;
			}
			formatListText += '|'+format.name;
			if (!format.challengeShow) formatListText += ',,';
			else if (!format.searchShow) formatListText += ',';
			if (format.team) formatListText += ',#';
		}
		return formatListText;
	};

	GlobalRoom.prototype.lastRoomReported = null;

	GlobalRoom.prototype.reportRecentBattles = function() {
		var rooms = this.getRoomList(false, this.lastRoomReported);
		if (Object.isEmpty(rooms)) return;
		this.lastRoomReported = null;
		var entries = [];
		for (var id in rooms) {
			var room = rooms[id];
			this.lastRoomReported = this.lastRoomReported || id;
			entries.push('|B|' + id + '|' + rooms[id].p1 + '|' + rooms[id].p2);
		}
		this.send(entries.join('\n'));
	};
	GlobalRoom.prototype.getRoomList = function(filter, lastRoomReported) {
		var roomList = {};
		var total = 0;
		for (var i=this.rooms.length-1; i>=0; i--) {
			var room = this.rooms[i];
			if (lastRoomReported && (room.id === lastRoomReported)) break;
			if (!room || !room.active) continue;
			if (filter && filter !== room.format && filter !== true) continue;
			var roomData = {};
			if (room.active && room.battle) {
				if (room.battle.players[0]) roomData.p1 = room.battle.players[0].getIdentity();
				if (room.battle.players[1]) roomData.p2 = room.battle.players[1].getIdentity();
			}
			if (!roomData.p1 || !roomData.p2) continue;
			roomList[room.id] = roomData;

			total++;
			if (total >= 6 && !filter) break;
		}
		return roomList;
	};
	GlobalRoom.prototype.cancelSearch = function(user) {
		var success = false;
		user.cancelChallengeTo();
		for (var i=0; i<this.searchers.length; i++) {
			var search = this.searchers[i];
			var searchUser = Users.get(search.userid);
			if (!searchUser.connected) {
				this.searchers.splice(i,1);
				i--;
				continue;
			}
			if (searchUser === user) {
				this.searchers.splice(i,1);
				i--;
				if (!success) {
					searchUser.send('|updatesearch|'+JSON.stringify({searching: false}));
					success = true;
				}
				continue;
			}
		}
		return success;
	};
	GlobalRoom.prototype.searchBattle = function(user, formatid) {
		if (!user.connected) return;
		if (lockdown) {
			user.popup("The server is shutting down. Battles cannot be started at this time.");
			return;
		}

		formatid = toId(formatid);

		var format = Tools.getFormat(formatid);
		if (!format.searchShow) {
			user.popup("That format is not available for searching.");
			return;
		}

		var team = user.team;
		var problems = Tools.validateTeam(team, formatid);
		if (problems) {
			user.popup("Your team was rejected for the following reasons:\n\n- "+problems.join("\n- "));
			return;
		}

		// tell the user they've started searching
		var newSearchData = {
			format: formatid
		};
		user.send('|updatesearch|'+JSON.stringify({searching: newSearchData}));

		// get the user's rating before actually starting to search
		var newSearch = {
			userid: user.userid,
			formatid: formatid,
			team: team,
			rating: 1500,
			time: new Date().getTime()
		};
		var self = this;
		user.doWithMMR(formatid, function(mmr) {
			newSearch.rating = mmr;
			self.addSearch(newSearch, user);
		});
	};
	GlobalRoom.prototype.matchmakingOK = function(search1, search2, user1, user2) {
		// users must be different
		if (user1 === user2) return false;

		// users must not have been matched immediately previously
		if (user1.lastMatch === user2.userid || user2.lastMatch === user1.userid) return false;

		// search must be within range
		var searchRange = 400, formatid = search1.formatid, elapsed = Math.abs(search1.time-search2.time);
		if (formatid === 'ou' || formatid === 'randombattle') searchRange = 200;
		searchRange += elapsed/300; // +1 every .3 seconds
		if (searchRange > 1200) searchRange = 1200;
		if (Math.abs(search1.rating - search2.rating) > searchRange) return false;

		user1.lastMatch = user2.userid;
		user2.lastMatch = user1.userid;
		return true;
	};
	GlobalRoom.prototype.addSearch = function(newSearch, user) {
		if (!user.connected) return;
		for (var i=0; i<this.searchers.length; i++) {
			var search = this.searchers[i];
			var searchUser = Users.get(search.userid);
			if (!searchUser || !searchUser.connected) {
				this.searchers.splice(i,1);
				i--;
				continue;
			}
			if (newSearch.formatid === search.formatid && searchUser === user) return; // only one search per format
			if (newSearch.formatid === search.formatid && this.matchmakingOK(search, newSearch, searchUser, user)) {
				this.cancelSearch(user, true);
				this.cancelSearch(searchUser, true);
				user.send('|updatesearch|'+JSON.stringify({searching: false}));
				this.startBattle(searchUser, user, search.formatid, true, search.team, newSearch.team);
				return;
			}
		}
		this.searchers.push(newSearch);
	};
	GlobalRoom.prototype.send = function(message, user) {
		if (user) {
			user.sendTo(this, message);
		} else {
			for (var i in this.users) {
				user = this.users[i];
				user.sendTo(this, message);
			}
		}
	};
	GlobalRoom.prototype.sendAuth = function(message) {
		for (var i in this.users) {
			var user = this.users[i];
			if (user.connected && user.can('receiveauthmessages')) {
				user.sendTo(this, message);
			}
		}
	};
	GlobalRoom.prototype.updateRooms = function(excludeUser) {
		// do nothing
	};
	GlobalRoom.prototype.add = function(message, noUpdate) {
		rooms.lobby.add(message, noUpdate);
	};
	GlobalRoom.prototype.addRaw = function(message) {
		rooms.lobby.addRaw(message);
	};
	GlobalRoom.prototype.onJoinSocket = function(user, socket) {
		var initdata = '|updateuser|'+user.name+'|'+(user.named?'1':'0')+'|'+user.avatar+'\n';
		sendData(socket, initdata+this.formatListText);
	};
	GlobalRoom.prototype.onJoin = function(user, merging) {
		if (!user) return false; // ???
		if (this.users[user.userid]) return user;

		this.users[user.userid] = user;
		if (++this.userCount > this.maxUsers) {
			this.maxUsers = this.userCount;
			this.maxUsersDate = Date.now();
		}

		if (!merging) {
			var initdata = '|updateuser|'+user.name+'|'+(user.named?'1':'0')+'|'+user.avatar+'\n';
			this.send(initdata+this.formatListText, user);
		}

		return user;
	};
	GlobalRoom.prototype.onRename = function(user, oldid, joining) {
		delete this.users[oldid];
		this.users[user.userid] = user;
		return user;
	};
	GlobalRoom.prototype.onUpdateIdentity = function() {};
	GlobalRoom.prototype.onLeave = function(user) {
		if (!user) return; // ...
		delete this.users[user.userid];
		--this.userCount;
		this.cancelSearch(user, true);
	};
	GlobalRoom.prototype.startBattle = function(p1, p2, format, rated, p1team, p2team) {
		var newRoom;
		p1 = Users.get(p1);
		p2 = Users.get(p2);

		if (!p1 || !p2) {
			// most likely, a user was banned during the battle start procedure
			this.cancelSearch(p1, true);
			this.cancelSearch(p2, true);
			return;
		}
		if (p1 === p2) {
			this.cancelSearch(p1, true);
			this.cancelSearch(p2, true);
			p1.popup("You can't battle your own account. Please use something like Private Browsing to battle yourself.");
			return;
		}

		if (lockdown) {
			this.cancelSearch(p1, true);
			this.cancelSearch(p2, true);
			p1.popup("The server is shutting down. Battles cannot be started at this time.");
			p2.popup("The server is shutting down. Battles cannot be started at this time.");
			return;
		}

		//console.log('BATTLE START BETWEEN: '+p1.userid+' '+p2.userid);
		var i = this.numRooms+1;
		var formaturlid = format.toLowerCase().replace(/[^a-z0-9]+/g,'');
		while(rooms['battle-'+formaturlid+i]) {
			i++;
		}
		this.numRooms = i;
		newRoom = this.addRoom('battle-'+formaturlid+'-'+i, format, p1, p2, this.id, rated);
		p1.joinRoom(newRoom);
		p2.joinRoom(newRoom);
		newRoom.joinBattle(p1, p1team);
		newRoom.joinBattle(p2, p2team);
		this.cancelSearch(p1, true);
		this.cancelSearch(p2, true);
		if (config.reportbattlesperiod) return;
		if (config.reportbattles) {
			rooms.lobby.add('|b|'+newRoom.id+'|'+p1.getIdentity()+'|'+p2.getIdentity());
		} else {
			this.send('|B|'+newRoom.id+'|'+p1.getIdentity()+'|'+p2.getIdentity());
		}
	};
	GlobalRoom.prototype.addRoom = function(room, format, p1, p2, parent, rated) {
		room = newRoom(room, format, p1, p2, parent, rated);
		if (typeof room.i[this.id] !== 'undefined') return;
		room.i[this.id] = this.rooms.length;
		this.rooms.push(room);
		return room;
	};
	GlobalRoom.prototype.removeRoom = function(room) {
		room = getRoom(room);
		if (!room) return;
		if (typeof room.i[this.id] !== 'undefined') {
			this.rooms.splice(room.i[this.id],1);
			delete room.i[this.id];
			for (var i=0; i<this.rooms.length; i++) {
				this.rooms[i].i[this.id] = i;
			}
		}
	};
	GlobalRoom.prototype.chat = function(user, message, socket) {
		rooms.lobby.chat(user, message, socket);
	};
	return GlobalRoom;
})();

var BattleRoom = (function() {
	function BattleRoom(roomid, format, p1, p2, parentid, rated) {
		this.id = roomid;
		this.i = {};

		format = ''+(format||'');

		this.users = {};
		this.format = format;
		//console.log("NEW BATTLE");

		var formatid = toId(format);

		if (rated && Tools.getFormat(formatid).rated) {
			rated = {
				p1: p1.userid,
				p2: p2.userid,
				format: format
			};
		} else {
			rated = false;
		}

		this.rated = rated;
		this.battle = Simulator.create(this.id, format, rated, this);

		this.parentid = parentid||'';
		this.p1 = p1 || '';
		this.p2 = p2 || '';

		this.sideTicksLeft = [21, 21];
		if (!rated) this.sideTicksLeft = [28,28];
		this.sideTurnTicks = [0, 0];

		this.log = [];
	}
	BattleRoom.prototype.type = 'battle';

	BattleRoom.prototype.resetTimer = null;
	BattleRoom.prototype.resetUser = '';
	BattleRoom.prototype.destroyTimer = null;
	BattleRoom.prototype.active = false;
	BattleRoom.prototype.lastUpdate = 0;

	BattleRoom.prototype.push = function(message) {
		if (typeof message === 'string') {
			this.log.push(message);
		} else {
			this.log = this.log.concat(message);
		}
	};
	BattleRoom.prototype.win = function(winner) {
		if (this.rated) {
			var winnerid = toId(winner);
			var rated = this.rated;
			this.rated = false;
			var p1score = 0.5;

			if (winnerid === rated.p1) {
				p1score = 1;
			} else if (winnerid === rated.p2) {
				p1score = 0;
			}

			var p1 = rated.p1;
			if (Users.getExact(rated.p1)) p1 = Users.getExact(rated.p1).name;
			var p2 = rated.p2;
			if (Users.getExact(rated.p2)) p2 = Users.getExact(rated.p2).name;

			//update.updates.push('[DEBUG] uri: '+config.loginserver+'action.php?act=ladderupdate&serverid='+config.serverid+'&p1='+encodeURIComponent(p1)+'&p2='+encodeURIComponent(p2)+'&score='+p1score+'&format='+toId(rated.format)+'&servertoken=[token]');

			if (!rated.p1 || !rated.p2) {
				this.push('|raw|ERROR: Ladder not updated: a player does not exist');
			} else {
				var winner = Users.get(winnerid);
				if (winner && !winner.authenticated) {
					this.send('|askreg|' + winner.userid, winner);
				}
				var p1rating, p2rating;
				// update rankings
				this.push('|raw|Ladder updating...');
				var self = this;
				LoginServer.request('ladderupdate', {
					p1: p1,
					p2: p2,
					score: p1score,
					format: toId(rated.format)
				}, function(data, statusCode, error) {
					if (!self.battle) {
						console.log('room expired before ladder update was received');
						return;
					}
					if (!data) {
						self.addRaw('Ladder (probably) updated, but score could not be retrieved ('+error+').');
						self.update();
						// log the battle anyway
						if (!Tools.getFormat(self.format).noLog) {
							self.logBattle(p1score);
						}
						return;
					} else {
						try {
							p1rating = data.p1rating;
							p2rating = data.p2rating;

							//self.add("Ladder updated.");

							var oldacre = Math.round(data.p1rating.oldacre);
							var acre = Math.round(data.p1rating.acre);
							var reasons = ''+(acre-oldacre)+' for '+(p1score>.99?'winning':(p1score<.01?'losing':'tying'));
							if (reasons.substr(0,1) !== '-') reasons = '+'+reasons;
							self.addRaw(sanitize(p1)+'\'s rating: '+oldacre+' &rarr; <strong>'+acre+'</strong><br />('+reasons+')');

							var oldacre = Math.round(data.p2rating.oldacre);
							var acre = Math.round(data.p2rating.acre);
							var reasons = ''+(acre-oldacre)+' for '+(p1score>.99?'losing':(p1score<.01?'winning':'tying'));
							if (reasons.substr(0,1) !== '-') reasons = '+'+reasons;
							self.addRaw(sanitize(p2)+'\'s rating: '+oldacre+' &rarr; <strong>'+acre+'</strong><br />('+reasons+')');

							Users.get(p1).cacheMMR(rated.format, data.p1rating);
							Users.get(p2).cacheMMR(rated.format, data.p2rating);
							self.update();
						} catch(e) {
							self.addRaw('There was an error calculating rating changes.');
							self.update();
						}

						if (!Tools.getFormat(self.format).noLog) {
							self.logBattle(p1score, p1rating, p2rating);
						}
					}
				});
			}
		}
		this.active = false;
		this.update();
	};
	// idx = 0, 1 : player log
	// idx = 2    : spectator log
	// idx = 3    : replay log
	BattleRoom.prototype.getLog = function(idx) {
		var log = [];
		for (var i = 0; i < this.log.length; ++i) {
			var line = this.log[i];
			if (line === '|split') {
				log.push(this.log[i + idx + 1]);
				i += 4;
			} else {
				log.push(line);
			}
		}
		return log;
	};
	BattleRoom.prototype.getLogForUser = function(user) {
		var slot = this.battle.getSlot(user);
		if (slot < 0) slot = 2;
		return this.getLog(slot);
	};
	BattleRoom.prototype.update = function(excludeUser) {
		if (this.log.length <= this.lastUpdate) return;
		var logs = [[], [], []];
		var updateLines = this.log.slice(this.lastUpdate);
		for (var i = 0; i < updateLines.length;) {
			var line = updateLines[i++];
			if (line === '|split') {
				logs[0].push(updateLines[i++]); // player 0
				logs[1].push(updateLines[i++]); // player 1
				logs[2].push(updateLines[i++]); // spectators
				i++; // replays
			} else {
				logs[0].push(line);
				logs[1].push(line);
				logs[2].push(line);
			}
		}
		var roomid = this.id;
		var self = this;
		logs = logs.map(function(log) {
			return log.join('\n');
		});
		this.lastUpdate = this.log.length;

		var hasUsers = false;
		for (var i in this.users) {
			var user = this.users[i];
			hasUsers = true;
			if (user === excludeUser) continue;
			var slot = this.battle.getSlot(user);
			if (slot < 0) slot = 2;
			this.send(logs[slot], user);
		}

		// empty rooms time out after ten minutes
		if (!hasUsers) {
			if (!this.destroyTimer) {
				this.destroyTimer = setTimeout(this.tryDestroy.bind(this), TIMEOUT_DEALLOCATE);
			}
		} else if (this.destroyTimer) {
			clearTimeout(this.destroyTimer);
			this.destroyTimer = null;
		}
	};
	BattleRoom.prototype.logBattle = function(p1score, p1rating, p2rating) {
		var logData = this.battle.logData;
		logData.p1rating = p1rating;
		logData.p2rating = p2rating;
		logData.endType = this.battle.endType;
		if (!p1rating) logData.ladderError = true;
		logData.log = BattleRoom.prototype.getLog.call(logData, 3); // replay log (exact damage)
		var date = new Date();
		var logfolder = date.format('{yyyy}-{MM}');
		var logsubfolder = date.format('{yyyy}-{MM}-{dd}');
		var curpath = 'logs/'+logfolder;
		var self = this;
		fs.mkdir(curpath, '0755', function() {
			var tier = self.format.toLowerCase().replace(/[^a-z0-9]+/g,'');
			curpath += '/'+tier;
			fs.mkdir(curpath, '0755', function() {
				curpath += '/'+logsubfolder;
				fs.mkdir(curpath, '0755', function() {
					fs.writeFile(curpath+'/'+self.id+'.log.json', JSON.stringify(logData));
				});
			});
		}); // asychronicity
		//console.log(JSON.stringify(logData));
		rooms.global.writeNumRooms();
	};
	BattleRoom.prototype.send = function(message, user) {
		if (user) {
			user.sendTo(this, message);
		} else {
			for (var i in this.users) {
				this.users[i].sendTo(this, message);
			}
		}
	};
	BattleRoom.prototype.tryDestroy = function() {
		for (var i in this.users) {
			// don't destroy ourselves if there are users in this room
			// theoretically, Room.update should've stopped tryDestroy's timer
			// well before we get here
			return;
		}
		this.destroy();
	};
	BattleRoom.prototype.reset = function(reload) {
		clearTimeout(this.resetTimer);
		this.resetTimer = null;
		this.resetUser = '';

		if (lockdown) {
			this.add('The battle was not restarted because the server is preparing to shut down.');
			return;
		}

		this.add('RESET');
		this.update();

		this.active = false;
		if (this.parentid) {
			getRoom(this.parentid).updateRooms();
		}
	};
	BattleRoom.prototype.getInactiveSide = function() {
		if (this.battle.players[0] && !this.battle.players[1]) return 1;
		if (this.battle.players[1] && !this.battle.players[0]) return 0;
		return this.battle.inactiveSide;
	};
	BattleRoom.prototype.forfeit = function(user, message, side) {
		if (!this.battle || this.battle.ended || !this.battle.started) return false;

		if (!message) message = ' forfeited.';

		if (side === undefined) {
			if (user && user.userid === this.battle.playerids[0]) side = 0;
			if (user && user.userid === this.battle.playerids[1]) side = 1;
		}
		if (side === undefined) return false;

		var ids = ['p1', 'p2'];
		var otherids = ['p2', 'p1'];

		var name = 'Player '+(side+1);
		if (user) {
			name = user.name;
		} else if (this.rated) {
			name = this.rated[ids[side]];
		}

		this.addCmd('-message', name+message);
		this.battle.endType = 'forfeit';
		this.battle.send('win', otherids[side]);
		this.active = this.battle.active;
		this.update();
		return true;
	};
	BattleRoom.prototype.kickInactive = function() {
		clearTimeout(this.resetTimer);
		this.resetTimer = null;

		if (!this.battle || this.battle.ended || !this.battle.started) return false;

		var inactiveSide = this.getInactiveSide();

		var ticksLeft = [0, 0];
		if (inactiveSide != 1) {
			// side 0 is inactive
			this.sideTurnTicks[0]--;
			this.sideTicksLeft[0]--;
		}
		if (inactiveSide != 0) {
			// side 1 is inactive
			this.sideTurnTicks[1]--;
			this.sideTicksLeft[1]--;
		}
		ticksLeft[0] = Math.min(this.sideTurnTicks[0], this.sideTicksLeft[0]);
		ticksLeft[1] = Math.min(this.sideTurnTicks[1], this.sideTicksLeft[1]);

		if (ticksLeft[0] && ticksLeft[1]) {
			if (inactiveSide == 0 || inactiveSide == 1) {
				// one side is inactive
				var inactiveTicksLeft = ticksLeft[inactiveSide];
				var inactiveUser = this.battle.getPlayer(inactiveSide);
				if (inactiveTicksLeft % 3 == 0 || inactiveTicksLeft <= 4) {
					this.send('|inactive|'+(inactiveUser?inactiveUser.name:'Player '+(inactiveSide+1))+' has '+(inactiveTicksLeft*10)+' seconds left.');
				}
			} else {
				// both sides are inactive
				var inactiveUser0 = this.battle.getPlayer(0);
				if (ticksLeft[0] % 3 == 0 || ticksLeft[0] <= 4) {
					this.send('|inactive|'+(inactiveUser0?inactiveUser0.name:'Player 1')+' has '+(ticksLeft[0]*10)+' seconds left.', inactiveUser0);
				}

				var inactiveUser1 = this.battle.getPlayer(1);
				if (ticksLeft[1] % 3 == 0 || ticksLeft[1] <= 4) {
					this.send('|inactive|'+(inactiveUser1?inactiveUser1.name:'Player 2')+' has '+(ticksLeft[1]*10)+' seconds left.', inactiveUser1);
				}
			}
			this.resetTimer = setTimeout(this.kickInactive.bind(this), 10*1000);
			return;
		}

		if (inactiveSide < 0) {
			if (ticksLeft[0]) inactiveSide = 1;
			else if (ticksLeft[1]) inactiveSide = 0;
		}

		this.forfeit(this.battle.getPlayer(inactiveSide),' lost because of their inactivity.', inactiveSide);
		this.resetUser = '';

		if (this.parentid) {
			getRoom(this.parentid).updateRooms();
		}
	};
	BattleRoom.prototype.requestKickInactive = function(user, force) {
		if (this.resetTimer) {
			this.send('|inactive|The inactivity timer is already counting down.', user);
			return false;
		}
		if (user) {
			if (!force && this.battle.getSlot(user) < 0) return false;
			this.resetUser = user.userid;
			this.send('|inactive|Battle timer is now ON: inactive players will automatically lose when time\'s up. (requested by '+user.name+')');
		}

		// a tick is 10 seconds

		var maxTicksLeft = 15; // 2 minutes 30 seconds
		if (!this.battle.p1 || !this.battle.p2) {
			// if a player has left, don't wait longer than 6 ticks (1 minute)
			maxTicksLeft = 6;
		}
		if (!this.rated) maxTicksLeft = 30;

		this.sideTurnTicks = [maxTicksLeft, maxTicksLeft];

		var inactiveSide = this.getInactiveSide();
		if (inactiveSide < 0) {
			// add 10 seconds to bank if they're below 160 seconds
			if (this.sideTicksLeft[0] < 16) this.sideTicksLeft[0]++;
			if (this.sideTicksLeft[1] < 16) this.sideTicksLeft[1]++;
		}
		this.sideTicksLeft[0]++;
		this.sideTicksLeft[1]++;
		if (inactiveSide != 1) {
			// side 0 is inactive
			var ticksLeft0 = Math.min(this.sideTicksLeft[0] + 1, maxTicksLeft);
			this.send('|inactive|You have '+(ticksLeft0*10)+' seconds to make your decision.', this.battle.getPlayer(0));
		}
		if (inactiveSide != 0) {
			// side 1 is inactive
			var ticksLeft1 = Math.min(this.sideTicksLeft[1] + 1, maxTicksLeft);
			this.send('|inactive|You have '+(ticksLeft1*10)+' seconds to make your decision.', this.battle.getPlayer(1));
		}

		this.resetTimer = setTimeout(this.kickInactive.bind(this), 10*1000);
		return true;
	};
	BattleRoom.prototype.nextInactive = function() {
		if (this.resetTimer) {
			this.update();
			clearTimeout(this.resetTimer);
			this.resetTimer = null;
			this.requestKickInactive();
		}
	};
	BattleRoom.prototype.stopKickInactive = function(user, force) {
		if (!force && user && user.userid !== this.resetUser) return false;
		if (this.resetTimer) {
			clearTimeout(this.resetTimer);
			this.resetTimer = null;
			this.send('|inactiveoff|Battle timer is now OFF.');
			return true;
		}
		return false;
	};
	BattleRoom.prototype.decision = function(user, choice, data) {
		this.battle.sendFor(user, choice, data);
		if (this.active !== this.battle.active) {
			this.active = this.battle.active;
			if (this.parentid) {
				getRoom(this.parentid).updateRooms();
			}
		}
		this.update();
	};
	// This function is only called when the room is not empty.
	// Joining an empty room calls this.join() below instead.
	BattleRoom.prototype.onJoinSocket = function(user, socket) {
		sendData(socket, '>'+this.id+'\n|init|battle\n'+this.getLogForUser(user).join('\n'));
		// this handles joining a battle in which a user is a participant,
		// where the user has already identified before attempting to join
		// the battle
		this.battle.resendRequest(user);
	};
	BattleRoom.prototype.onJoin = function(user) {
		if (!user) return false;
		if (this.users[user.userid]) return user;

		this.users[user.userid] = user;

		if (user.named) {
			this.addCmd('join', user.name);
			this.update(user);
		}

		this.send('|init|battle\n'+this.getLogForUser(user).join('\n'), user);
		return user;
	};
	BattleRoom.prototype.onRename = function(user, oldid, joining) {
		if (joining) {
			this.addCmd('join', user.name);
		}
		var resend = joining || !this.battle.playerTable[oldid];
		if (this.battle.playerTable[oldid]) {
			if (this.rated) {
				this.add('|message|'+user.name+' forfeited by changing their name.');
				this.battle.lose(oldid);
				this.battle.leave(oldid);
				resend = false;
			} else {
				this.battle.rename();
			}
		}
		delete this.users[oldid];
		this.users[user.userid] = user;
		this.update();
		if (resend) {
			// this handles a named user renaming themselves into a user in the
			// battle (i.e. by using /nick)
			this.battle.resendRequest(user);
		}
		return user;
	};
	BattleRoom.prototype.onUpdateIdentity = function() {};
	BattleRoom.prototype.onLeave = function(user) {
		if (!user) return; // ...
		if (user.battles[this.id]) {
			this.battle.leave(user);
			this.active = this.battle.active;
			if (this.parentid) {
				getRoom(this.parentid).updateRooms();
			}
		} else if (!user.named) {
			delete this.users[user.userid];
			return;
		}
		delete this.users[user.userid];
		this.addCmd('leave', user.name);

		if (Object.isEmpty(this.users)) {
			this.active = false;
		}

		this.update();
	};
	BattleRoom.prototype.joinBattle = function(user, team) {
		var slot = undefined;
		if (this.rated) {
			if (this.rated.p1 === user.userid) {
				slot = 0;
			} else if (this.rated.p2 === user.userid) {
				slot = 1;
			} else {
				return;
			}
		}

		this.battle.join(user, slot, team);
		this.active = this.battle.active;
		this.update();

		if (this.parentid) {
			getRoom(this.parentid).updateRooms();
		}
	};
	BattleRoom.prototype.leaveBattle = function(user) {
		if (!user) return false; // ...
		if (user.battles[this.id]) {
			this.battle.leave(user);
		} else {
			return false;
		}
		this.active = this.battle.active;
		this.update();

		if (this.parentid) {
			getRoom(this.parentid).updateRooms();
		}
		return true;
	};
	BattleRoom.prototype.addCmd = function() {
		this.log.push('|'+Array.prototype.slice.call(arguments).join('|'));
	};
	BattleRoom.prototype.add = function(message) {
		if (message.rawMessage) {
			this.addCmd('raw', message.rawMessage);
		} else if (message.name) {
			this.addCmd('chat', message.name.substr(1), message.message);
		} else {
			this.log.push(message);
		}
	};
	BattleRoom.prototype.addRaw = function(message) {
		this.addCmd('raw', message);
	};
	BattleRoom.prototype.chat = function(user, message, connection) {
		// Battle actions are actually just text commands that are handled in
		// parseCommand(), which in turn often calls Simulator.prototype.sendFor().
		// Sometimes the call to sendFor is done indirectly, by calling
		// room.decision(), where room.constructor === BattleRoom.

		message = CommandParser.parse(message, this, user, connection);

		if (!message) {
			// do nothing
		} else if (message.substr(0,3) === '>> ') {
			var cmd = message.substr(3);

			var room = this;
			var battle = this.battle;
			var me = user;
			this.addCmd('chat', user.name, '>> '+cmd);
			if (user.checkConsolePermission(connection.socket)) {
				try {
					this.addCmd('chat', user.name, '<< '+eval(cmd));
				} catch (e) {
					this.addCmd('chat', user.name, '<< error: '+e.message);
					var stack = (""+e.stack).split("\n");
					for (var i=0; i<stack.length; i++) {
						this.send('<< '+stack[i], user);
					}
				}
			} else {
				this.addCmd('chat', user.name, '<< Access denied.');
			}
		} else if (message.substr(0,4) === '>>> ') {
			var cmd = message.substr(4);

			this.addCmd('chat', user.name, '>>> '+cmd);
			if (user.checkConsolePermission(connection.socket)) {
				this.battle.send('eval', cmd);
			} else {
				this.addCmd('chat', user.name, '<<< Access denied.');
			}
		} else {
			this.battle.chat(user, message);
		}
		this.update();
	};
	BattleRoom.prototype.addModCommand = function(result) {
		this.add(result);
		this.logModCommand(result);
	};
	BattleRoom.prototype.logModCommand = function(result) {
		modlog.write('['+(new Date().toJSON())+'] ('+room.id+') '+result+'\n');
	};
	BattleRoom.prototype.destroy = function() {
		// deallocate ourself

		// remove references to ourself
		for (var i in this.users) {
			this.users[i].leaveRoom(this);
			delete this.users[i];
		}
		this.users = null;

		rooms.global.removeRoom(this.id);

		// deallocate children and get rid of references to them
		if (this.battle) {
			this.battle.destroy();
		}
		this.battle = null;

		if (this.resetTimer) {
			clearTimeout(this.resetTimer);
		}
		this.resetTimer = null;

		// get rid of some possibly-circular references
		delete rooms[this.id];
	};
	return BattleRoom;
})();

var ChatRoom = (function() {
	function ChatRoom(roomid) {
		this.id = roomid;
		this.i = {};

		this.log = [];
		this.lastUpdate = 0;
		this.users = {};
		this.searchers = [];
		this.logFile = null;
		this.logFilename = '';
		this.destroyingLog = false;

		// `config.loglobby` is a legacy name
		if (config.logchat || config.loglobby) {
			this.rollLogFile(true);
			this.logEntry = function(entry, date) {
				var timestamp = (new Date()).format('{HH}:{mm}:{ss} ');
				this.logFile.write(timestamp + entry + '\n');
			};
			this.logEntry('NEW CHATROOM: ' + this.id);
			if (config.loguserstats) {
				setInterval(this.logUserStats.bind(this), config.loguserstats);
			}
		} else {
			this.logEntry = function() { };
		}

		if (config.reportjoinsperiod) {
			this.userList = this.getUserList();
		}
		this.reportJoinsQueue = [];
		this.lastGlobalCount = -1;
		this.reportJoinsInterval = setInterval(
			this.reportRecentJoins.bind(this), config.reportjoinsperiod
		);
	}
	ChatRoom.prototype.type = 'chat';

	ChatRoom.prototype.reportRecentJoins = function() {
		// special case for the lobby
		if ((this.id === 'lobby') && (this.lastGlobalCount !== rooms.global.userCount)) {
			this.reportJoinsQueue.push('|usercount|' + rooms.global.userCount);
			this.lastGlobalCount = rooms.global.userCount;
		} else if (this.reportJoinsQueue.length === 0) {
			// nothing to report
			return;
		}
		this.userList = this.getUserList();
		this.send(this.reportJoinsQueue.join('\n'));
		this.reportJoinsQueue.length = 0;
	};

	ChatRoom.prototype.rollLogFile = function(sync) {
		var mkdir = sync ? (function(path, mode, callback) {
			try {
				fs.mkdirSync(path, mode);
			} catch (e) {}	// directory already exists
			callback();
		}) : fs.mkdir;
		var date = new Date();
		var basepath = 'logs/chat/' + this.id + '/';
		var self = this;
		mkdir(basepath, '0755', function() {
			var path = date.format('{yyyy}-{MM}');
			mkdir(basepath + path, '0755', function() {
				if (self.destroyingLog) return;
				path += '/' + date.format('{yyyy}-{MM}-{dd}') + '.txt';
				if (path !== self.logFilename) {
					self.logFilename = path;
					if (self.logFile) self.logFile.destroySoon();
					self.logFile = fs.createWriteStream(basepath + path, {flags: 'a'});
					// Create a symlink to today's lobby log.
					// These operations need to be synchronous, but it's okay
					// because this code is only executed once every 24 hours.
					var link0 = basepath + 'today.txt.0';
					try {
						fs.unlinkSync(link0);
					} catch (e) {} // file doesn't exist
					try {
						fs.symlinkSync(path, link0); // `basepath` intentionally not included
						try {
							fs.renameSync(link0, basepath + 'today.txt');
						} catch (e) {} // OS doesn't support atomic rename
					} catch (e) {} // OS doesn't support symlinks
				}
				var timestamp = +date;
				date.advance('1 hour').reset('minutes').advance('1 second');
				setTimeout(self.rollLogFile.bind(self), +date - timestamp);
			});
		});
	};
	ChatRoom.prototype.destroyLog = function(initialCallback, finalCallback) {
		this.destroyingLog = true;
		initialCallback();
		if (this.logFile) {
			this.logEntry = function() { };
			this.logFile.on('close', finalCallback);
			this.logFile.destroySoon();
		} else {
			finalCallback();
		}
	};
	ChatRoom.prototype.logUserStats = function() {
		var total = 0;
		var guests = 0;
		var groups = {};
		config.groupsranking.forEach(function(group) {
			groups[group] = 0;
		});
		for (var i in this.users) {
			var user = this.users[i];
			++total;
			if (!user.named) {
				++guests;
			}
			++groups[user.group];
		}
		var entry = '|userstats|total:' + total + '|guests:' + guests;
		for (var i in groups) {
			entry += '|' + i + ':' + groups[i];
		}
		this.logEntry(entry);
	};

	ChatRoom.prototype.getUserList = function() {
		var buffer = '';
		var counter = 0;
		for (var i in this.users) {
			if (!this.users[i].named) {
				continue;
			}
			counter++;
			buffer += ','+this.users[i].getIdentity();
		}
		var msg = '|users|'+counter+buffer;
		if (this.id === 'lobby') {
			msg += '\n|usercount|'+rooms.global.userCount;
		}
		return msg;
	};
	ChatRoom.prototype.update = function() {
		if (this.log.length <= this.lastUpdate) return;
		var entries = this.log.slice(this.lastUpdate);
		var update = entries.join('\n');
		if (this.log.length > 100) {
			this.log.splice(0, this.log.length - 100);
		}
		this.lastUpdate = this.log.length;

		this.send(update);
	};
	ChatRoom.prototype.send = function(message, user) {
		if (user) {
			user.sendTo(this, message);
		} else {
			for (var i in this.users) {
				this.users[i].sendTo(this, message);
			}
		}
	};
	ChatRoom.prototype.sendAuth = function(message) {
		for (var i in this.users) {
			var user = this.users[i];
			if (user.connected && user.can('receiveauthmessages')) {
				user.sendTo(this, message);
			}
		}
	};
	ChatRoom.prototype.add = function(message, noUpdate) {
		this.log.push(message);
		this.logEntry(message);
		if (!noUpdate) {
			this.update();
		}
	};
	ChatRoom.prototype.addRaw = function(message) {
		this.add('|raw|'+message);
	};
	ChatRoom.prototype.onJoinSocket = function(user, socket) {
		var userList = this.userList ? this.userList : this.getUserList();
		sendData(socket, '>'+this.id+'\n|init|chat\n'+userList+'\n'+this.log.slice(-25).join('\n'));
	};
	ChatRoom.prototype.onJoin = function(user, merging) {
		if (!user) return false; // ???
		if (this.users[user.userid]) return user;

		this.users[user.userid] = user;
		if (user.named && config.reportjoins) {
			this.add('|j|'+user.getIdentity(), true);
			this.update(user);
		} else if (user.named) {
			var entry = '|J|'+user.getIdentity();
			if (config.reportjoinsperiod) {
				this.reportJoinsQueue.push(entry);
			} else {
				this.send(entry);
			}
			this.logEntry(entry);
		}

		if (!merging) {
			var userList = this.userList ? this.userList : this.getUserList();
			this.send('|init|chat\n'+userList+'\n'+this.log.slice(-100).join('\n'), user);
		}

		return user;
	};
	ChatRoom.prototype.onRename = function(user, oldid, joining) {
		delete this.users[oldid];
		this.users[user.userid] = user;
		var entry;
		if (joining) {
			if (config.reportjoins) {
				entry = '|j|' + user.getIdentity();
			} else {
				entry = '|J|' + user.getIdentity();
			}
		} else if (!user.named) {
			entry = '|L| ' + oldid;
		} else {
			entry = '|N|' + user.getIdentity() + '|' + oldid;
		}
		if (config.reportjoins) {
			this.add(entry);
		} else {
			if (config.reportjoinsperiod) {
				this.reportJoinsQueue.push(entry);
			} else {
				this.send(entry);
			}
			this.logEntry(entry);
		}
		return user;
	};
	/**
	 * onRename, but without a userid change
	 */
	ChatRoom.prototype.onUpdateIdentity = function(user) {
		if (user && user.connected && user.named) {
			var entry = '|N|' + user.getIdentity() + '|' + user.userid;
			if (config.reportjoinsperiod) {
				this.reportJoinsQueue.push(entry);
			} else {
				this.send(entry);
			}
		}
	};
	ChatRoom.prototype.onLeave = function(user) {
		if (!user) return; // ...
		delete this.users[user.userid];
		if (config.reportjoins) {
			this.add('|l|'+user.getIdentity());
		} else if (user.named) {
			var entry = '|L|' + user.getIdentity();
			if (config.reportjoinsperiod) {
				this.reportJoinsQueue.push(entry);
			} else {
				this.send(entry);
			}
			this.logEntry(entry);
		}
	};
	ChatRoom.prototype.chat = function(user, message, connection) {
		message = CommandParser.parse(message, this, user, connection);

		if (!message) {
			// do nothing
		} else if (message.substr(0,3) === '>> ') {
			var cmd = message.substr(3);

			var room = this;
			var me = user;
			this.add('|c|'+user.getIdentity()+'|>> '+cmd, true);
			if (user.checkConsolePermission(connection.socket)) {
				try {
					this.add('|c|'+user.getIdentity()+'|<< '+eval(cmd), true);
				} catch (e) {
					this.add('|c|'+user.getIdentity()+'|<< error: '+e.message, true);
					var stack = (""+e.stack).split("\n");
					for (var i=0; i<stack.length; i++) {
						user.sendTo(this.id, '<< '+stack[i]);
					}
				}
			} else {
				this.add('|c|'+user.getIdentity()+'|<< Access denied.', true);
			}
		} else {
			this.add('|c|'+user.getIdentity()+'|'+message, true);
		}
		this.update();
	};
	ChatRoom.prototype.addModCommand = function(result) {
		this.add(result);
		this.logModCommand(result);
	};
	ChatRoom.prototype.logModCommand = function(result) {
		modlog.write('['+(new Date().toJSON())+'] ('+room.id+') '+result+'\n');
	};
	return ChatRoom;
})();

// to make sure you don't get null returned, pass the second argument
var getRoom = function(roomid, fallback) {
	if (roomid && roomid.id) return roomid;
	if (!roomid) roomid = 'default';
	if (!rooms[roomid] && fallback) {
		return rooms.lobby;
	}
	return rooms[roomid];
};
var newRoom = function(roomid, format, p1, p2, parent, rated) {
	if (roomid && roomid.id) return roomid;
	if (!p1 || !p2) return false;
	if (!roomid) roomid = 'default';
	if (!rooms[roomid]) {
		console.log("NEW ROOM: "+roomid);
		rooms[roomid] = new BattleRoom(roomid, format, p1, p2, parent, rated);
	}
	return rooms[roomid];
};

var rooms = {};
console.log("NEW GLOBAL: global");
rooms.global = new GlobalRoom('global');
console.log("NEW CHATROOM: lobby");
rooms.lobby = new ChatRoom('lobby');

exports.GlobalRoom = GlobalRoom;
exports.BattleRoom = BattleRoom;
exports.ChatRoom = ChatRoom;

exports.get = getRoom;
exports.create = newRoom;
exports.rooms = rooms;
exports.global = rooms.global;
exports.lobby = rooms.lobby;
