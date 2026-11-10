#!/usr/bin/env python3
"""Build SUMO networks from the same OSM extract used by the web app.
   python backend/build_net.py   -> backend/sumo/dongda_static.net.xml, dongda_actuated.net.xml"""
import os, subprocess, sys
import sumo  # eclipse-sumo wheel
HERE = os.path.dirname(os.path.abspath(__file__))
OSM = os.path.join(HERE, '..', 'data', 'raw', 'dongda_roads.osm')
OUT = os.path.join(HERE, 'sumo')
NETCONVERT = os.path.join(sumo.SUMO_HOME, 'bin', 'netconvert')

def build(kind):
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f'dongda_{kind}.net.xml')
    cmd = [NETCONVERT, '--osm-files', OSM, '-o', out, '--geometry.remove', '--roundabouts.guess', '--ramps.guess',
           '--junctions.join', '--tls.guess-signals', '--tls.discard-simple', '--tls.join', '--tls.default-type', kind,
           '--tls.yellow.time', '3', '--tls.allred.time', '2', '--tls.cycle.time', '90', '--osm.sidewalks', 'false',
           '--keep-edges.by-vclass', 'motorcycle', '--no-turnarounds', 'true', '--default.lanewidth', '3.2', '--output.street-names', 'true', '--no-warnings']
    subprocess.run(cmd, check=True)
    print('wrote', out)

if __name__ == '__main__':
    for k in (sys.argv[1:] or ['static', 'actuated']):
        build(k)
