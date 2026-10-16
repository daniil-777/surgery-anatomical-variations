import copy
import unittest
from assess_liver_motion_capture import assess_capture_data, sphere_surface_penetration_mm
import numpy as np


class MotionCaptureAssessmentTests(unittest.TestCase):
    def fixture(self):
        points = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]
        samples = []
        for i in range(3):
            samples.append({'wall_time_s': i * .1, 'segment': 0, 'paused': False,
                            'node_positions_mm': points[:],
                            'camera_position_mm':[0,0,100], 'camera_target_mm':[0,0,0],
                            'camera_fov_degrees':45, 'camera_aspect':1.5,
                            'metrics': {'simulation_time_s': i * .1, 'minimum_jacobian': 1,
                                        'probe_reaction_n': [-2, 0, 0], 'probe_normal_force_n': 2,
                                        'probe_work_j': i * .002, 'floor_friction_dissipated_j': i * .001},
                            'contact': {'probe': {'centerMm': [i, 20, 0], 'radiusMm': 6}}})
        return {'schema': 'viscera.liver-motion-capture/1',
                'units': {'positions': 'mm', 'time': 's', 'force': 'N', 'work': 'J'},
                'cage': {'reference_positions_mm': points, 'tets': [0, 1, 2, 3], 'surface_indices':[0,2,1, 0,1,3, 0,3,2, 1,2,3]}, 'samples': samples}

    def test_work_sign_units_and_independent_geometry(self):
        result = assess_capture_data(self.fixture())
        self.assertEqual(result['numerical_status'], 'PASS')
        self.assertAlmostEqual(result['independent_minimum_jacobian'], 1)
        self.assertAlmostEqual(result['probe_work_audit']['coarse_signed_work_on_tissue_j'], .004)
        self.assertAlmostEqual(result['probe_work_audit']['coarse_minus_solver_j'], 0)

    def test_reset_prevents_spurious_work_and_missing_force_is_not_zero_measurement(self):
        data = self.fixture()
        data['samples'][2]['segment'] = 1
        data['samples'][2]['metrics']['simulation_time_s'] = 0
        data['samples'][2]['contact']['probe']['centerMm'] = [1000, 20, 0]
        result = assess_capture_data(data)
        self.assertEqual(len(result['segments']), 2)
        self.assertAlmostEqual(result['probe_work_audit']['coarse_signed_work_on_tissue_j'], .002)
        without_work = copy.deepcopy(data)
        for sample in without_work['samples']:
            sample['metrics'].pop('probe_work_j')
        self.assertIsNone(assess_capture_data(without_work)['probe_work_audit']['solver_work_change_on_same_pairs_j'])
        for sample in data['samples']:
            sample['metrics'].pop('probe_reaction_n')
        self.assertEqual(assess_capture_data(data)['probe_work_audit']['status'], 'NOT_RUN')

    def test_inversion_reported_even_if_runtime_metric_is_positive(self):
        data = self.fixture()
        data['samples'][1]['node_positions_mm'][9:12] = [0, 0, -10]
        result = assess_capture_data(data)
        self.assertEqual(result['numerical_status'], 'FAIL')
        self.assertLess(result['independent_minimum_jacobian'], 0)


    def test_signed_surface_detects_inside_and_edge_contact(self):
        data = self.fixture()
        x = np.array(data['cage']['reference_positions_mm']).reshape(-1,3)
        faces = np.array(data['cage']['surface_indices']).reshape(-1,3)
        penetration, contained, distance = sphere_surface_penetration_mm(x, faces, np.array([1.,1.,1.]), .1)
        self.assertTrue(contained)
        self.assertAlmostEqual(distance, 1)
        self.assertAlmostEqual(penetration, 1.1)
        penetration, contained, distance = sphere_surface_penetration_mm(x, faces, np.array([-1.,-1.,5.]), 2)
        self.assertFalse(contained)
        self.assertAlmostEqual(distance, np.sqrt(2))
        self.assertAlmostEqual(penetration, 2-np.sqrt(2))
        data['samples'][0]['contact']['probe'] = {'centerMm':[1,1,1], 'radiusMm':.1}
        data['samples'][0]['metrics']['maximum_probe_surface_penetration_mm'] = 0
        self.assertEqual(assess_capture_data(data)['numerical_status'], 'FAIL')

    def test_lifecycle_counters_exclude_hidden_reactivation_and_camera_guards(self):
        data = self.fixture()
        for i,sample in enumerate(data['samples']):
            sample['metrics']['probe_activation_count'] = 1 if i == 0 else 2
            sample['metrics']['probe_removal_count'] = 0 if i == 0 else 1
        result = assess_capture_data(data)
        self.assertEqual(result['probe_work_audit']['eligible_adjacent_pairs'], 1)
        self.assertEqual(result['camera_audit']['status'], 'PASS')
        self.assertIn('probe_activation_count:1',result['contact_lifecycle_boundaries'][1]['reasons'])
        data['samples'][0]['camera_aspect'] = 0
        with self.assertRaises(ValueError): assess_capture_data(data)

    def test_clock_unit_and_passivity_guards(self):
        data = self.fixture()
        data['samples'][2]['metrics']['floor_friction_dissipated_j'] = -.1
        self.assertEqual(assess_capture_data(data)['numerical_status'], 'FAIL')
        for change in ['units', 'clock', 'wall']:
            bad = copy.deepcopy(self.fixture())
            if change == 'units': bad['units']['positions'] = 'm'
            if change == 'clock': bad['samples'][2]['metrics']['simulation_time_s'] = .05
            if change == 'wall': bad['samples'][2]['wall_time_s'] = .05
            with self.assertRaises(ValueError): assess_capture_data(bad)


if __name__ == '__main__':
    unittest.main()
